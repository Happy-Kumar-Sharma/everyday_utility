// Remote sessions: adds a "Log out" button to the sidebar footer when signed in over a remote host.
import { h, toastError } from './dom.js';
import { get, post } from './api.js';

async function logout() {
  try {
    await post('/api/auth/logout');
    location.replace('/login');
  } catch (e) { toastError(e); }
}

async function init() {
  let status;
  try { status = await get('/api/auth/status'); } catch { return; }
  if (!status.remote || !status.authenticated) return;
  document.querySelector('.sidebar-footer')?.append(
    h('button', { id: 'logout-btn', class: 'nav-item', type: 'button', title: 'End this remote session', onclick: logout },
      h('span', { class: 'nav-icon' }, '🚪'), h('span', {}, 'Log out')));
}

init();
