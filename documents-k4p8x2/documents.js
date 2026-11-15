(() => {
  const UPLOAD_URL = 'https://superagent92.app.n8n.cloud/webhook/lechem-docs-upload';
  const STATUS_URL = 'https://superagent92.app.n8n.cloud/webhook/lechem-docs-status';
  const POLL_INTERVAL_MS = 2000;
  const MAX_POLLS = 90; // 3 דקות של שאלות בלי סיום
  const UPLOAD_TIMEOUT_MS = 60000;
  const MAX_FILE_BYTES = 10 * 1024 * 1024;
  const CODE_KEY = 'lechem-docs-admin-code';
  const ALLOWED_EXT = ['pdf', 'docx', 'txt', 'md'];

  // השלבים שהזרימה ב-n8n רושמת ב-lechem_versions.stage כשהיא מתחילה כל אחד מהם
  // label: השורה ברשימת השלבים. name: איך השלב נקרא בכותרת של כישלון.
  const STAGES = [
    { key: 'received', label: 'הקובץ התקבל', name: 'קבלת הקובץ' },
    { key: 'ingesting', label: 'עיבוד (חיתוך, הטמעה ושמירה)', name: 'העיבוד (חיתוך, הטמעה ושמירה)' },
    { key: 'verifying', label: 'בדיקה שכל החתיכות נכנסו', name: 'הבדיקה' },
    { key: 'swapping', label: 'החלפת הגרסה', name: 'ההחלפה' },
  ];
  const STAGE_KEYS = STAGES.map((s) => s.key);

  const DOCS = {
    pricelist: { title: 'מחירון', the: 'המחירון', topic: 'מחירים ודמי משלוח' },
    'delivery-zones': { title: 'אזורי משלוח', the: 'מסמך אזורי המשלוח', topic: 'אזורים, שעות והזמנות' },
  };
  const DOC_ORDER = ['pricelist', 'delivery-zones'];

  const simulate = new URLSearchParams(window.location.search).get('simulate') === 'fail';

  const $ = (id) => document.getElementById(id);
  const screens = {
    gate: $('screen-gate'),
    main: $('screen-main'),
    progress: $('screen-progress'),
    done: $('screen-done'),
    failed: $('screen-failed'),
    timeout: $('screen-timeout'),
  };

  const fileInput = $('file-input');
  const submitButton = $('submit-button');
  const progressSteps = $('progress-steps');

  class AuthError extends Error {}

  // הקוד נשמר רק בלשונית הזאת. אם האחסון חסום, הוא נשאר רק בזיכרון של הדף.
  const store = {
    get() { try { return window.sessionStorage.getItem(CODE_KEY) || ''; } catch (e) { return ''; } },
    set(v) { try { window.sessionStorage.setItem(CODE_KEY, v); } catch (e) { /* בזיכרון בלבד */ } },
    clear() { try { window.sessionStorage.removeItem(CODE_KEY); } catch (e) { /* אין מה לנקות */ } },
  };

  let code = store.get();
  const state = { file: null, busy: false, docKey: null, jobId: null, polls: 0, timer: null, documents: [] };

  // ───────── עזרים ─────────

  function showScreen(name) {
    Object.entries(screens).forEach(([key, el]) => { el.hidden = key !== name; });
    window.scrollTo(0, 0);
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function ltr(text) {
    return el('span', 'ltr-num', text);
  }

  // "ב-<תאריך>" כיחידה אחת שלא נשברת בין שורות
  function onDate(iso) {
    const span = el('span', 'nowrap');
    span.append('ב‑', ltr(formatDate(iso)));
    return span;
  }

  const dateParts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });

  function formatDate(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const p = Object.fromEntries(dateParts.formatToParts(d).map((x) => [x.type, x.value]));
    return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
  }

  function formatBytes(bytes) {
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function chunksText(n) {
    return n === 1 ? 'חתיכה אחת' : `${n} חתיכות`;
  }

  function activeDoc(docKey) {
    const d = (state.documents || []).find((x) => x.doc_key === docKey);
    return d && d.file_name && d.updated_at ? d : null;
  }

  function stageName(key) {
    const s = STAGES.find((x) => x.key === key);
    return s ? s.name : '';
  }

  // ───────── שרת ─────────

  async function fetchStatus(jobId) {
    const res = await fetch(STATUS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-code': code },
      body: JSON.stringify({ jobId: jobId || null }),
    });
    if (res.status === 401 || res.status === 403) throw new AuthError();
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.ok) throw new Error((data && data.error) || 'status');
    state.documents = Array.isArray(data.documents) ? data.documents : [];
    return data;
  }

  async function refreshDocuments() {
    const errorEl = $('docs-error');
    try {
      await fetchStatus(null);
      errorEl.hidden = true;
    } catch (err) {
      if (err instanceof AuthError) { toGate('הקוד כבר לא תקף. הכניסו אותו שוב.'); return; }
      errorEl.textContent = 'לא הצלחנו לטעון את רשימת המסמכים. הרשימה למטה אולי לא מעודכנת.';
      errorEl.hidden = false;
    }
    renderDocs($('active-docs'));
  }

  // ───────── רשימת המסמכים הפעילים ─────────

  function renderDocs(list) {
    list.replaceChildren();
    DOC_ORDER.forEach((key) => {
      const info = DOCS[key];
      const d = activeDoc(key);
      const li = el('li', d ? 'doc' : 'doc doc--missing');
      li.append(el('p', 'doc__title', info.title));
      if (d) {
        li.append(el('p', 'doc__chunks', chunksText(Number(d.chunk_count) || 0)));
        const meta = el('p', 'doc__meta');
        meta.append(`${d.file_name} · עודכן `, onDate(d.updated_at));
        li.append(meta);
      } else {
        li.append(el('p', 'doc__meta', `אין גרסה פעילה. הבוט לא עונה על ${info.topic}.`));
      }
      list.append(li);
    });
  }

  // ───────── שלבים ─────────

  // stage: השלב האחרון שהשרת דיווח עליו (או null לפני שהשרת ענה).
  // failedStage: השלב שבו השרת רשם כישלון.
  function renderSteps(list, { stage = null, failedStage = null } = {}) {
    list.replaceChildren();
    const current = stage === 'done' ? STAGES.length : STAGE_KEYS.indexOf(stage);
    const failed = STAGE_KEYS.indexOf(failedStage);
    STAGES.forEach((s, i) => {
      const li = el('li', 'step', s.label);
      if (failed >= 0) {
        if (i < failed) li.classList.add('is-done');
        else if (i === failed) {
          li.classList.add('is-failed');
          li.append(el('span', 'step__note', 'כאן ההעלאה נעצרה'));
        } else li.classList.add('is-skipped');
      } else if (current >= 0) {
        if (i < current) li.classList.add('is-done');
        if (i === current) {
          li.classList.add('is-current');
          li.setAttribute('aria-current', 'step');
        }
      }
      list.append(li);
    });
  }

  function renderLive() {
    const d = activeDoc(state.docKey);
    const info = DOCS[state.docKey];
    const meta = $('live-meta');
    meta.replaceChildren();
    if (d) {
      $('live-file').textContent = d.file_name;
      meta.append('עודכן ', onDate(d.updated_at), ` · ${chunksText(Number(d.chunk_count) || 0)}`);
    } else {
      $('live-file').textContent = `עדיין אין ${info.title} פעיל`;
      meta.textContent = `הבוט לא עונה על ${info.topic} עד שההעלאה תצליח.`;
    }
  }

  // ───────── כניסה ─────────

  function toGate(message) {
    clearTimeout(state.timer);
    code = '';
    store.clear();
    const err = $('gate-error');
    err.textContent = message || '';
    err.hidden = !message;
    $('gate-code').value = '';
    showScreen('gate');
    $('gate-code').focus();
  }

  $('gate-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('gate-error');
    const button = $('gate-button');
    const value = $('gate-code').value.trim();
    err.hidden = true;
    if (!value) {
      err.textContent = 'צריך להכניס את קוד המנהל.';
      err.hidden = false;
      return;
    }
    // כותרות HTTP לא יכולות להכיל עברית או רווחים
    if (!/^[\x21-\x7e]+$/.test(value)) {
      err.textContent = 'הקוד יכול להכיל רק אותיות באנגלית, ספרות וסימנים, בלי רווחים.';
      err.hidden = false;
      return;
    }
    code = value;
    button.disabled = true;
    button.textContent = 'בודקים...';
    try {
      await fetchStatus(null);
      store.set(value);
      showMain();
    } catch (ex) {
      code = '';
      err.textContent = ex instanceof AuthError
        ? 'הקוד שגוי.'
        : 'לא הצלחנו להתחבר למערכת. בדקו את החיבור ונסו שוב.';
      err.hidden = false;
    } finally {
      button.disabled = false;
      button.textContent = 'כניסה';
    }
  });

  $('logout').addEventListener('click', () => toGate(''));

  // ───────── בחירת קובץ ─────────

  function showUploadError(message) {
    const e = $('upload-error');
    e.textContent = message;
    e.hidden = !message;
  }

  function pickFile(file) {
    showUploadError('');
    if (!file) return;
    const ext = (file.name.includes('.') ? file.name.split('.').pop() : '').toLowerCase();
    if (!ALLOWED_EXT.includes(ext)) {
      showUploadError('אפשר להעלות רק קובץ PDF, Word (docx), TXT או MD.');
      fileInput.value = '';
      return;
    }
    if (file.size === 0) {
      showUploadError('הקובץ ריק.');
      fileInput.value = '';
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      showUploadError('הקובץ גדול מ-10MB.');
      fileInput.value = '';
      return;
    }
    state.file = file;
    $('selected-name').textContent = file.name;
    $('selected-size').textContent = formatBytes(file.size);
    $('selected').hidden = false;
    submitButton.disabled = false;
  }

  function clearFile() {
    state.file = null;
    fileInput.value = '';
    $('selected').hidden = true;
    submitButton.disabled = true;
    showUploadError('');
  }

  fileInput.addEventListener('change', () => pickFile(fileInput.files[0]));
  $('clear-file').addEventListener('click', clearFile);

  // ───────── העלאה ─────────

  async function submit() {
    if (state.busy || !state.file) return;
    const docKey = document.querySelector('input[name="docKey"]:checked').value;
    state.busy = true;
    state.docKey = docKey;
    state.jobId = null;
    state.polls = 0;

    $('progress-doc').textContent = DOCS[docKey].the;
    $('new-file').textContent = state.file.name;
    $('sending').hidden = false;
    renderSteps(progressSteps, {});
    renderLive();
    showScreen('progress');

    const body = new FormData();
    body.append('docKey', docKey);
    if (simulate) body.append('simulate', 'fail');
    body.append('document', state.file, state.file.name);

    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
    try {
      const res = await fetch(UPLOAD_URL, {
        method: 'POST',
        headers: { 'x-admin-code': code },
        body,
        signal: controller.signal,
      });
      if (res.status === 401 || res.status === 403) {
        state.busy = false;
        toGate('הקוד כבר לא תקף. הכניסו אותו שוב ונסו שוב.');
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok || !data.jobId) {
        finishFailed({ stage: 'received', reason: data.error || 'המערכת לא קיבלה את הקובץ.' });
        return;
      }
      // השרת יצר את הגרסה החדשה (שלב received) והחזיר את המספר שלה
      state.jobId = data.jobId;
      $('sending').hidden = true;
      renderSteps(progressSteps, { stage: 'received' });
      state.timer = setTimeout(poll, POLL_INTERVAL_MS);
    } catch (err) {
      finishFailed({
        stage: null,
        reason: err.name === 'AbortError'
          ? 'השליחה לקחה יותר מדקה ולא קיבלנו תשובה מהמערכת.'
          : 'הקובץ לא הגיע למערכת. בדקו את החיבור לאינטרנט ונסו שוב.',
      });
    } finally {
      clearTimeout(abortTimer);
    }
  }

  async function poll() {
    state.polls += 1;
    try {
      const data = await fetchStatus(state.jobId);
      renderLive();
      const job = data.job;
      if (job) {
        if (job.status === 'active' || job.status === 'superseded') { finishDone(job); return; }
        if (job.status === 'failed') {
          finishFailed({ stage: job.failed_stage, reason: job.error_message });
          return;
        }
        renderSteps(progressSteps, { stage: job.stage });
      }
    } catch (err) {
      if (err instanceof AuthError) {
        state.busy = false;
        toGate('הקוד כבר לא תקף. ההעלאה ממשיכה ברקע. הכניסו את הקוד כדי לראות את המצב.');
        return;
      }
      // תקלה רגעית ברשת לא עוצרת את הבדיקה, היא רק נספרת כניסיון
    }
    if (state.polls >= MAX_POLLS) { showScreen('timeout'); return; }
    state.timer = setTimeout(poll, POLL_INTERVAL_MS);
  }

  // ───────── תוצאות ─────────

  function finishDone(job) {
    const info = DOCS[state.docKey];
    const inserted = Number(job.inserted_chunks) || 0;
    const deleted = Number(job.deleted_old_chunks) || 0;
    $('done-title').textContent = `${info.the} הוחלף`;
    $('done-lead').textContent = `נכנסו ${chunksText(inserted)} חדשות ונבדקו. `
      + (deleted > 0 ? `${chunksText(deleted)} של הגרסה הקודמת נמחקו. ` : 'לא הייתה גרסה קודמת. ')
      + `מעכשיו הבוט עונה לפי ${job.file_name}.`;
    renderDocs($('done-docs'));
    showScreen('done');
  }

  function renderKeep() {
    const box = $('failed-keep');
    const info = DOCS[state.docKey];
    const d = activeDoc(state.docKey);
    box.replaceChildren();
    if (d) {
      box.className = 'keep';
      const line = el('span');
      line.append(`הבוט ממשיך לענות לפי ${d.file_name}, שעודכן `, onDate(d.updated_at), '.');
      box.append(el('strong', '', 'הגרסה הקודמת עדיין פעילה'), line);
    } else {
      box.className = 'keep keep--none';
      box.append(
        el('strong', '', `עדיין אין ${info.title} פעיל`),
        el('span', '', `הבוט לא עונה על ${info.topic} עד שהעלאה תצליח.`),
      );
    }
  }

  function finishFailed({ stage, reason }) {
    const label = stageName(stage);
    $('failed-title').textContent = label ? `ההעלאה נכשלה בשלב ${label}` : 'ההעלאה לא התחילה';
    $('failed-reason').textContent = reason || 'המערכת לא מסרה סיבה.';
    const steps = $('failed-steps');
    steps.hidden = !label;
    if (label) renderSteps(steps, { failedStage: stage });
    renderKeep();
    showScreen('failed');
    // מוודאים מול השרת מה פעיל עכשיו, ומעדכנים אם משהו השתנה
    fetchStatus(null).then(renderKeep).catch(() => {});
  }

  function showMain() {
    clearTimeout(state.timer);
    state.busy = false;
    state.jobId = null;
    clearFile();
    $('simulate-tag').hidden = !simulate;
    renderDocs($('active-docs'));
    showScreen('main');
  }

  function restart() {
    showMain();
    refreshDocuments();
  }

  submitButton.addEventListener('click', submit);
  document.querySelectorAll('[data-action="restart"]').forEach((b) => b.addEventListener('click', restart));
  $('resume-button').addEventListener('click', () => {
    if (!state.jobId) return;
    state.polls = 0;
    showScreen('progress');
    poll();
  });

  // ───────── פתיחה ─────────

  if (code) {
    fetchStatus(null)
      .then(showMain)
      .catch((err) => {
        if (err instanceof AuthError) toGate('הקוד כבר לא תקף. הכניסו אותו שוב.');
        else { showMain(); refreshDocuments(); }
      });
  } else {
    toGate('');
  }
})();
