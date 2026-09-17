/**
 * A dropped audio file as both a playable element and a decoded buffer.
 *
 * The element is what the user hears and what feeds the analyser in real time.
 * The buffer is the same audio sitting in memory, which Task 8 sweeps faster
 * than real time to build a timeline before playback starts — the one thing a
 * local file can offer that a YouTube tab cannot.
 *
 * The caller owns both: connect `node` through the audio graph (to the
 * analyser *and* destination — nothing else is playing this), and revoke
 * `el.src` when it is finished with it.
 */

export interface FileSource {
  node: MediaElementAudioSourceNode;
  el: HTMLAudioElement;
  /** A decoded copy of the whole file, for the offline analysis pass. */
  buffer: AudioBuffer;
}

export async function createFileSource(ctx: AudioContext, file: File): Promise<FileSource> {
  // Decode first: `createMediaElementSource` permanently rewires an element,
  // so there is no point building one for a file we cannot play.
  let buffer: AudioBuffer;
  try {
    buffer = await ctx.decodeAudioData(await file.arrayBuffer());
  } catch {
    throw new Error(`${file.name} could not be decoded — try mp3, m4a, wav, ogg or flac`);
  }

  const el = new Audio();
  el.src = URL.createObjectURL(file);
  el.preload = 'auto';

  return { node: ctx.createMediaElementSource(el), el, buffer };
}
