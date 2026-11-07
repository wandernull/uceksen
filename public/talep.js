// Contact / consulting request modal. Posts to /api/talep; without JS the form posts natively.
(function () {
  var modal = document.getElementById('talepModal');
  var form = document.getElementById('talepForm');
  var done = document.getElementById('talepDone');
  var err = document.getElementById('talepHata');
  if (!modal || !form || !done || !err) return;
  var submit = form.querySelector('button[type="submit"]');
  var submitLabel = submit ? submit.textContent : '';

  function showError(msg) { err.textContent = msg; err.hidden = false; }
  function open() {
    form.hidden = false;
    done.hidden = true;
    err.hidden = true;
    form.reset();
    if (typeof modal.showModal === 'function') { modal.showModal(); }
    else { modal.setAttribute('open', ''); }
  }
  function close() {
    if (typeof modal.close === 'function') { modal.close(); }
    else { modal.removeAttribute('open'); }
  }

  document.querySelectorAll('[data-open]').forEach(function (el) { el.addEventListener('click', open); });
  modal.querySelectorAll('[data-close]').forEach(function (el) { el.addEventListener('click', close); });
  modal.addEventListener('click', function (e) { if (e.target === modal) close(); });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    err.hidden = true;
    if (!form.checkValidity()) { form.reportValidity(); return; }
    var data = {};
    new FormData(form).forEach(function (v, k) { data[k] = v; });
    if (submit) { submit.disabled = true; submit.textContent = 'Gönderiliyor…'; }
    fetch('/api/talep', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data)
    })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (body) {
          if (res.ok && body.ok) { form.hidden = true; done.hidden = false; return; }
          showError(body.error || 'Bir sorun oldu. Biraz sonra tekrar dene.');
        });
      })
      .catch(function () { showError('Bağlantı kurulamadı. İnternet bağlantını kontrol edip tekrar dene.'); })
      .then(function () { if (submit) { submit.disabled = false; submit.textContent = submitLabel; } });
  });
})();
