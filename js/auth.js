/* Login and register forms. Passwords are sent over the API to the server, which hashes them with scrypt.
   Nothing here ever asks for or stores a Roblox password. */
(function () {
  'use strict';
  const BH = window.BH;
  const form = BH.$('#auth-form');
  if (!form) return;
  const isRegister = BH.page === 'register';
  const errorBox = BH.$('#auth-error');
  const submit = BH.$('#auth-submit');
  const next = BH.safeNext(new URLSearchParams(location.search).get('next'));

  const googleMsg = {
    unlinked: 'No Harbour account is linked to that Google account. Log in with your password, then connect Google in Settings.',
    banned: 'This account has been suspended.', cancelled: 'Google sign-in was cancelled.', unverified: 'Google did not confirm that email address.',
    unavailable: 'Google sign-in is not set up on this server yet.', error: 'Google sign-in failed. Please try again.'
  }[new URLSearchParams(location.search).get('google')];
  if (googleMsg) errorBox.textContent = googleMsg;
  BH.ready.then(() => { const g = BH.$('#google-login'); if (g && BH.googleEnabled) g.hidden = false; });

  // Already signed in? Skip the form.
  BH.ready.then((me) => { if (me) location.replace(next); });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorBox.textContent = '';
    const username = form.username.value.trim();
    const password = form.password.value;

    if (!username || !password) { errorBox.textContent = 'Enter your username and password.'; return; }
    if (isRegister) {
      if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) { errorBox.textContent = 'Username must be 3 to 20 letters, numbers or underscores.'; return; }
      if (password.length < 8) { errorBox.textContent = 'Password must be at least 8 characters.'; return; }
      if (password !== form.confirm.value) { errorBox.textContent = 'The two passwords do not match.'; return; }
    }

    submit.disabled = true;
    try {
      const body = isRegister
        ? { username, password, displayName: form.displayName.value.trim() }
        : { username, password };
      await BH.api(isRegister ? '/auth/register' : '/auth/login', { method: 'POST', body });
      location.href = next;
    } catch (err) {
      errorBox.textContent = err.message;
      submit.disabled = false;
    }
  });
})();
