// Booking pages: show slots in the visitor's own time zone, and switch zones without a button.
(function () {
  var form = document.querySelector(".tz-form");
  if (!form) return;
  var url = new URL(location.href);
  // First visit to the picker: use the browser's zone (the server defaulted to the host's).
  if (!url.searchParams.get("tz") && !/\/degistir$/.test(url.pathname)) {
    try {
      var zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      var select = form.querySelector("select");
      if (zone && select && select.value !== zone && select.querySelector('option[value="' + zone + '"]')) {
        url.searchParams.set("tz", zone);
        location.replace(url.toString());
        return;
      }
    } catch (e) {}
  }
  var sel = form.querySelector("select[data-autosubmit]");
  if (sel) sel.addEventListener("change", function () { form.submit(); });
})();
