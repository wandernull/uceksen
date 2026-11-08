// Theme: follows the OS by default; the nav button cycles Otomatik → Açık → Koyu.
// Loaded in <head> without defer so the saved choice applies before first paint.
(function () {
  var KEY = "uceksen-theme";
  var ORDER = ["auto", "light", "dark"];
  var LABEL = { auto: "Tema: otomatik (cihaz ayarı)", light: "Tema: açık", dark: "Tema: koyu" };
  var root = document.documentElement;

  function read() {
    try {
      var v = localStorage.getItem(KEY);
      return v === "light" || v === "dark" ? v : "auto";
    } catch (e) {
      return "auto";
    }
  }
  function apply(choice) {
    if (choice === "auto") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", choice);
    root.setAttribute("data-theme-choice", choice);
    var buttons = document.querySelectorAll("[data-theme-toggle]");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute("aria-label", LABEL[choice]);
      buttons[i].setAttribute("title", LABEL[choice]);
    }
  }

  apply(read());
  document.addEventListener("DOMContentLoaded", function () {
    apply(read());
    document.addEventListener("click", function (e) {
      var btn = e.target.closest && e.target.closest("[data-theme-toggle]");
      if (!btn) return;
      var next = ORDER[(ORDER.indexOf(read()) + 1) % ORDER.length];
      try {
        if (next === "auto") localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, next);
      } catch (err) {}
      apply(next);
    });
  });
})();
