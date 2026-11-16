// Boutons de la page de test (fichier séparé : pas de script inline).
const v1 = document.getElementById('v1');
document.getElementById('fsContainer').onclick = () => document.getElementById('player').requestFullscreen();
document.getElementById('fsVideo').onclick = () => v1.requestFullscreen();
document.getElementById('rate').onclick = (e) => {
  v1.playbackRate = v1.playbackRate === 1 ? 1.5 : 1;
  e.target.textContent = `Vitesse ×${v1.playbackRate === 1 ? '1.5' : '1'}`;
};
document.getElementById('addVideo').onclick = () => {
  const v = document.createElement('video');
  v.src = 'media/bbb.webm';
  v.controls = true;
  v.width = 480;
  document.getElementById('dyn').appendChild(v);
};
