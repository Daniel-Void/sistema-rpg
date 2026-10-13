// Ícones em SVG (traço simples, herdam a cor do texto).
const paths = {
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/>',
  micOff: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/><path d="M4 4l16 16"/>',
  screen: '<rect x="3" y="4" width="18" height="12" rx="1"/><path d="M8 20h8"/><path d="M12 16v4"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="1"/><circle cx="9" cy="9" r="2"/><path d="M21 15l-5-5L5 21"/>',
  film: '<rect x="3" y="4" width="18" height="16" rx="1"/><path d="M7 4v16M17 4v16M3 9h4M17 9h4M3 15h4M17 15h4"/>',
  music: '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
  volume: '<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M17 9a4 4 0 0 1 0 6"/>',
  play: '<path d="M7 4l13 8-13 8z"/>',
  stop: '<rect x="6" y="6" width="12" height="12"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  pencil: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  back: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5M4 20h16"/>',
  whisper: '<path d="M21 12a8 8 0 0 1-11.8 7L4 20l1-5.2A8 8 0 1 1 21 12z"/>',
  broadcast: '<path d="M3 10v4h4l7 4V6l-7 4z"/><path d="M18 8a5 5 0 0 1 0 8"/>',
  logout: '<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="1"/><path d="M5 15V5h10"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M3 3l18 18"/><path d="M10.6 5.1A9.8 9.8 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.2 6.3C3.6 8 2 12 2 12s3.5 7 10 7c1.6 0 3-.4 4.2-1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  volumeOff: '<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M17 10l4 4M21 10l-4 4"/>',
  dice: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.2" fill="currentColor"/><circle cx="16" cy="16" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/>',
  users: '<circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0"/><path d="M16 5a3 3 0 0 1 0 6M21 20a6 6 0 0 0-4-5.6"/>',
};

export function icon(name, size = 18) {
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || ''}</svg>`;
}

/** Marca do site: um d20 estilizado. */
export const logo = `<svg class="logo" width="26" height="26" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M16 2l12 7v14l-12 7-12-7V9z"/><path d="M16 8l7 12H9z"/><path d="M16 2v6M4 9l12-1 12 1M4 9l5 11-5 3M28 9l-5 11 5 3M9 20l7 10 7-10"/></svg>`;

/** Substitui <i data-icon="nome"></i> por SVG. */
export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => {
    el.outerHTML = icon(el.dataset.icon, Number(el.dataset.size) || 18);
  });
  root.querySelectorAll('[data-logo]').forEach((el) => {
    el.outerHTML = logo;
  });
}
