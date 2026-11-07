const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const statusText = document.getElementById('statusText');
const countText = document.getElementById('countText');
const urlWarning = document.getElementById('urlWarning');

const TARGET_PATH = '/your_activity/interactions/likes';

function render(data) {
  countText.textContent = data.selectedCount || 0;

  let s = 'Hazır';
  if (data.status === 'running') s = 'Çalışıyor...';
  else if (data.status === 'done') s = 'Tamamlandı ✅';
  else if (data.status === 'stopped') s = 'Durduruldu';
  else if (data.status === 'error') s = 'Hata — Console\'u kontrol et';
  statusText.textContent = 'Durum: ' + s;

  const isRunning = !!data.running;
  startBtn.disabled = isRunning;
  stopBtn.disabled = !isRunning;
}

function refresh() {
  chrome.storage.local.get(['running', 'selectedCount', 'status'], render);
}

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const url = tabs[0] && tabs[0].url ? tabs[0].url : '';
  urlWarning.style.display = url.includes(TARGET_PATH) ? 'none' : 'block';
});

refresh();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  refresh();
});

startBtn.addEventListener('click', () => {
  chrome.storage.local.set({ running: true, status: 'running' });
});

stopBtn.addEventListener('click', () => {
  chrome.storage.local.set({ running: false, status: 'stopped' });
});
