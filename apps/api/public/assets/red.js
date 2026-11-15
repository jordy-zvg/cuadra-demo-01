// Aviso de conexión compartido por todas las pantallas de Cuadra.
// Aparece si el aparato se queda sin internet o si el servidor deja de responder dos veces seguidas;
// se quita solo al volver. Las pantallas avisan con cuadraNet.ok() y cuadraNet.fail().
// cuadraNet.toast(texto, ok) muestra un mensaje breve abajo (en lugar de alert()).
(() => {
  "use strict";
  const icon = (n) => `<svg class="ico" aria-hidden="true"><use href="/assets/icons.svg#i-${n}"/></svg>`;
  const make = (cls) => { const el = document.createElement("div"); el.className = cls; el.hidden = true; el.setAttribute("role", "status"); return el; };
  const bar = make("netbar"), toast = make("toast");
  const mount = () => document.body.append(bar, toast);
  document.body ? mount() : addEventListener("DOMContentLoaded", mount);

  let fails = 0, toastTimer = 0;
  const offlineText = "Sin internet. Lo que ves puede no estar al día.";
  const show = (text) => { bar.innerHTML = icon("wifi_off") + "<span></span>"; bar.lastChild.textContent = text; bar.hidden = false; };
  addEventListener("offline", () => show(offlineText));
  addEventListener("online", () => { fails = 0; bar.hidden = true; });

  window.cuadraNet = {
    ok() { fails = 0; if (navigator.onLine) bar.hidden = true; },
    fail() { if (++fails >= 2) show(navigator.onLine ? "No hay respuesta del servidor. Reintentando…" : offlineText); },
    toast(text, ok = false) {
      toast.className = "toast" + (ok ? " ok" : "");
      toast.innerHTML = icon(ok ? "check_circle" : "error") + "<span></span>";
      toast.lastChild.textContent = text;
      toast.hidden = false;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { toast.hidden = true; }, 5000);
    },
  };
})();
