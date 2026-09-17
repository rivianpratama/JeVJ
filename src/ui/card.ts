/**
 * The centre card: an oval, feather-edged window onto the video.
 *
 * Three stacked pieces — a blurred halo behind, the masked card itself, and a
 * label underneath — so the video melts into the visualizer rather than
 * sitting on top of it in a rectangle.
 */

export interface Card {
  /** The element the YouTube IFrame API replaces with its iframe. */
  playerMount: HTMLElement;
  setLabel(text: string): void;
  setMode(m: 'video' | 'file'): void;
}

export function createCard(root: HTMLElement): Card {
  const stage = document.createElement('div');
  stage.className = 'card-stage';

  const frame = document.createElement('div');
  frame.className = 'card-frame';

  const halo = document.createElement('div');
  halo.className = 'card-halo';

  const card = document.createElement('div');
  card.className = 'card';
  card.dataset['mode'] = 'video';

  // YT.Player replaces this element with its iframe, keeping the id.
  const playerMount = document.createElement('div');
  playerMount.className = 'card-player';
  playerMount.id = 'yt-mount';

  const file = document.createElement('div');
  file.className = 'card-file';
  file.setAttribute('aria-hidden', 'true');
  file.textContent = '♪';

  const label = document.createElement('div');
  label.className = 'card-label';

  card.append(playerMount, file);
  frame.append(halo, card);
  stage.append(frame, label);
  root.append(stage);

  return {
    playerMount,
    setLabel(text: string): void {
      label.textContent = text;
    },
    setMode(m: 'video' | 'file'): void {
      card.dataset['mode'] = m;
    },
  };
}
