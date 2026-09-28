const form = document.querySelector("#loginForm");
const err = document.querySelector("#loginError");
form.onsubmit = async (e) => {
  e.preventDefault();
  err.hidden = true;
  const btn = form.querySelector("button");
  btn.disabled = true;
  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: document.querySelector("#password").value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "ログインできませんでした");
    location.href = "/";
  } catch (e2) {
    err.textContent = e2.message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
  }
};
