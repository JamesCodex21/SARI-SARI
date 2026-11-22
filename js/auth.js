/* Sign-in, administrator gate, password reset. Row Level Security is the real protection; this only routes users. */
const Auth = (() => {
  const adminRow = async user => {
    if (!user) return null;
    const { data, error } = await sb.from('admin_profiles').select('id, display_name').eq('id', user.id).maybeSingle();
    if (error) throw error;
    return data;
  };

  // Called by app.js before any page loads. Redirects to login unless the user is an authorized administrator.
  async function guard() {
    const { data: { session } } = await sb.auth.getSession();
    const admin = session ? await adminRow(session.user) : null;
    if (!admin) {
      if (session) await sb.auth.signOut();
      location.replace('login.html');
      return null;
    }
    return { ...admin, email: session.user.email };
  }

  async function signIn(email, password) {
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw new Error('Email or password is incorrect.');
    const admin = await adminRow(data.user);
    if (!admin) {
      await sb.auth.signOut();
      throw new Error('This account is not an authorized administrator.');
    }
    return admin;
  }

  const signOut = async () => { await sb.auth.signOut(); location.replace('login.html'); };

  function wireLogin() {
    const msg = t => { document.querySelector('#msg').textContent = t; };
    const loginForm = document.querySelector('#loginForm');
    const pwForm = document.querySelector('#newPwForm');

    loginForm.addEventListener('submit', async e => {
      e.preventDefault();
      const d = new FormData(e.target);
      msg('Signing in…');
      try {
        await signIn(String(d.get('email')).trim(), String(d.get('password')));
        location.replace('index.html');
      } catch (err) { msg(err.message); }
    });

    document.querySelector('#forgotBtn').addEventListener('click', async () => {
      const email = String(document.querySelector('[name=email]').value).trim();
      if (!email) return msg('Enter your email first, then press Forgot password.');
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + '/login.html' });
      msg(error ? 'Could not send the reset email. Try again later.'
        : 'If this is an administrator account, a reset link was sent to its email.');
    });

    pwForm.addEventListener('submit', async e => {
      e.preventDefault();
      const pw = String(new FormData(e.target).get('pw'));
      if (pw.length < 8) return msg('Use at least 8 characters.');
      const { error } = await sb.auth.updateUser({ password: pw });
      if (error) return msg(error.message);
      await sb.auth.signOut();
      pwForm.hidden = true; loginForm.hidden = false;
      msg('Password updated. Sign in with your new password.');
    });

    sb.auth.onAuthStateChange(event => {
      if (event === 'PASSWORD_RECOVERY') {
        loginForm.hidden = true; pwForm.hidden = false; msg('Choose a new password.');
      }
    });
  }

  if (document.querySelector('#loginForm')) wireLogin();
  return { guard, signOut };
})();
