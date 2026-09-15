(() => {
  const SUBMIT_URL = 'https://superagent92.app.n8n.cloud/webhook/lechem-invoice-submit';
  const STATUS_URL = 'https://superagent92.app.n8n.cloud/webhook/lechem-invoice-status';
  const POLL_INTERVAL_MS = 3000;
  const MAX_POLLS = 40;
  const SUBMIT_TIMEOUT_MS = 90000;
  const MAX_FILE_BYTES = 20 * 1024 * 1024;
  const STAGES = ['upload', 'queued', 'parsing', 'extracting', 'saving'];

  const $ = (id) => document.getElementById(id);

  const screens = {
    upload: $('screen-upload'),
    wait: $('screen-wait'),
    success: $('screen-success'),
    failed: $('screen-failed'),
    timeout: $('screen-timeout'),
  };

  const cameraPicker = $('camera-picker');
  const cameraInput = $('camera-input');
  const fileInput = $('file-input');
  const selected = $('selected');
  const selectedThumb = $('selected-thumb');
  const selectedName = $('selected-name');
  const selectedSize = $('selected-size');
  const uploadError = $('upload-error');
  const submitButton = $('submit-button');
  const resumeButton = $('resume-button');
  const elapsedEl = $('elapsed');

  const state = {
    file: null,
    busy: false,
    jobId: null,
    polls: 0,
    startedAt: 0,
    elapsedTimer: null,
    thumbUrl: null,
  };

  if (window.matchMedia('(pointer: coarse)').matches) {
    cameraPicker.hidden = false;
  }

  function showScreen(name) {
    Object.entries(screens).forEach(([key, el]) => {
      el.hidden = key !== name;
    });
    window.scrollTo(0, 0);
  }

  function formatBytes(bytes) {
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function showUploadError(message) {
    uploadError.textContent = message;
    uploadError.hidden = !message;
  }

  function pickFile(file) {
    showUploadError('');
    if (!file) return;

    const isImage = file.type.startsWith('image/');
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    if (!isImage && !isPdf) {
      showUploadError('אפשר להעלות רק תמונה או PDF.');
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      showUploadError('הקובץ גדול מ-20MB. נסו לצלם שוב או לשמור בגודל קטן יותר.');
      return;
    }

    state.file = file;
    if (state.thumbUrl) URL.revokeObjectURL(state.thumbUrl);
    state.thumbUrl = isImage ? URL.createObjectURL(file) : null;
    selectedThumb.hidden = !isImage;
    if (isImage) selectedThumb.src = state.thumbUrl;
    selectedName.textContent = file.name || 'צילום';
    selectedSize.textContent = formatBytes(file.size);
    selected.hidden = false;
    submitButton.disabled = false;
  }

  function clearFile() {
    state.file = null;
    cameraInput.value = '';
    fileInput.value = '';
    selected.hidden = true;
    submitButton.disabled = true;
    showUploadError('');
  }

  cameraInput.addEventListener('change', () => pickFile(cameraInput.files[0]));
  fileInput.addEventListener('change', () => pickFile(fileInput.files[0]));
  $('clear-file').addEventListener('click', clearFile);

  function setStage(stage) {
    const current = STAGES.indexOf(stage);
    document.querySelectorAll('.step').forEach((el) => {
      const index = STAGES.indexOf(el.dataset.stage);
      el.classList.toggle('is-done', current > index);
      el.classList.toggle('is-current', current === index);
      if (current === index) {
        el.setAttribute('aria-current', 'step');
      } else {
        el.removeAttribute('aria-current');
      }
    });
  }

  function startElapsed() {
    state.startedAt = Date.now();
    elapsedEl.textContent = '0:00';
    clearInterval(state.elapsedTimer);
    state.elapsedTimer = setInterval(() => {
      const seconds = Math.floor((Date.now() - state.startedAt) / 1000);
      elapsedEl.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    }, 1000);
  }

  function stopElapsed() {
    clearInterval(state.elapsedTimer);
  }

  async function submit() {
    if (state.busy || !state.file) return;
    state.busy = true;
    submitButton.disabled = true;
    submitButton.textContent = 'שולחים...';

    showScreen('wait');
    setStage('upload');
    startElapsed();

    const body = new FormData();
    body.append('document', state.file, state.file.name || 'invoice.jpg');
    body.append('fileName', state.file.name || 'invoice.jpg');

    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), SUBMIT_TIMEOUT_MS);

    try {
      const response = await fetch(SUBMIT_URL, { method: 'POST', body, signal: controller.signal });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok || !data.jobId) {
        finishFailed(data.error || 'השרת לא קיבל את הקובץ.', { reachedServer: Boolean(data.error) });
        return;
      }
      state.jobId = data.jobId;
      state.polls = 0;
      setStage('queued');
      schedulePoll();
    } catch (err) {
      finishFailed(err.name === 'AbortError'
        ? 'השליחה לקחה יותר מדי זמן. בדקו את החיבור ונסו שוב.'
        : 'לא הצלחנו להתחבר לשרת. בדקו את החיבור לאינטרנט ונסו שוב.', { reachedServer: false });
    } finally {
      clearTimeout(abortTimer);
    }
  }

  function schedulePoll() {
    setTimeout(poll, POLL_INTERVAL_MS);
  }

  async function poll() {
    state.polls += 1;
    try {
      const response = await fetch(STATUS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: state.jobId }),
      });
      const data = await response.json();

      if (data.stage === 'done' && data.result) {
        finishSuccess(data.result);
        return;
      }
      if (data.stage === 'failed') {
        finishFailed(data.error || 'העיבוד נכשל.');
        return;
      }
      if (STAGES.includes(data.stage)) setStage(data.stage);
    } catch (err) {
      // תקלה רגעית ברשת לא עוצרת את הבדיקה, רק נספרת כניסיון
    }

    if (state.polls >= MAX_POLLS) {
      finishTimeout();
      return;
    }
    schedulePoll();
  }

  const money = new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', minimumFractionDigits: 2 });

  function formatDate(iso) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    return match ? `${match[3]}/${match[2]}/${match[1]}` : (iso || '');
  }

  function addField(list, label, value, { money: isMoney = false, ltr = false } = {}) {
    const row = document.createElement('div');
    row.className = isMoney ? 'fields__row fields__row--money' : 'fields__row';
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    const empty = value === null || value === undefined || value === '';
    const text = empty ? 'לא זוהה' : (isMoney ? money.format(Number(value)) : String(value));
    if (ltr && !empty) {
      const span = document.createElement('span');
      span.className = 'ltr-num';
      span.textContent = text;
      dd.appendChild(span);
    } else {
      dd.textContent = text;
    }
    row.append(dt, dd);
    list.appendChild(row);
  }

  function finishSuccess(result) {
    stopElapsed();
    const list = $('result-fields');
    list.replaceChildren();
    addField(list, 'ספק', result.supplier);
    addField(list, 'תאריך', formatDate(result.invoiceDate), { ltr: true });
    addField(list, 'מספר חשבונית', result.invoiceNumber, { ltr: true });
    addField(list, 'סכום לפני מע״מ', result.amountBeforeVat, { money: true });
    addField(list, 'סכום אחרי מע״מ', result.amountAfterVat, { money: true });
    addField(list, 'סוג השירות', result.serviceType);

    const check = $('result-check');
    check.textContent = result.amountsCheck || '';
    check.className = `check ${result.amountsOk ? 'check--ok' : 'check--warn'}`;
    check.hidden = !result.amountsCheck;

    const driveWrap = $('result-drive-wrap');
    if (result.driveUrl) {
      $('result-drive').href = result.driveUrl;
      driveWrap.hidden = false;
    } else {
      driveWrap.hidden = true;
    }
    showScreen('success');
  }

  function finishFailed(message, { reachedServer = true } = {}) {
    stopElapsed();
    $('failed-message').textContent = message;
    $('failed-note').textContent = reachedServer
      ? 'נשלח מייל עם הפרטים. אפשר לנסות שוב עם צילום ברור יותר, או להקליד את החשבונית הזו ידנית.'
      : 'החשבונית לא הגיעה למערכת, ולכן גם לא נשלח מייל. כדאי לנסות שוב בעוד רגע.';
    showScreen('failed');
  }

  function finishTimeout() {
    stopElapsed();
    showScreen('timeout');
  }

  function restart() {
    stopElapsed();
    state.busy = false;
    state.jobId = null;
    state.polls = 0;
    submitButton.textContent = 'שליחה לעיבוד';
    clearFile();
    showScreen('upload');
  }

  submitButton.addEventListener('click', submit);
  document.querySelectorAll('[data-action="restart"]').forEach((btn) => btn.addEventListener('click', restart));

  resumeButton.addEventListener('click', () => {
    if (!state.jobId) return;
    state.polls = 0;
    showScreen('wait');
    startElapsed();
    poll();
  });
})();
