/**
 * A thin, dismissable strip across the top of the page — used for the
 * browser-support notice (tab capture needs a Chromium browser).
 */

let banner: HTMLElement | null = null;

/**
 * `html` is app-authored markup (it may contain links); never pass anything
 * that came from a video title, a URL or any other outside source.
 */
export function showBanner(html: string): void {
  if (!banner?.isConnected) {
    banner = document.createElement('div');
    banner.className = 'banner';
    banner.setAttribute('role', 'note');

    const text = document.createElement('div');
    text.className = 'banner-text';

    const close = document.createElement('button');
    close.className = 'banner-close';
    close.type = 'button';
    close.setAttribute('aria-label', 'dismiss');
    close.textContent = '×';
    close.addEventListener('click', hideBanner);

    banner.append(text, close);
    document.body.append(banner);
  }

  const text = banner.querySelector('.banner-text');
  if (text) text.innerHTML = html;
  banner.classList.add('is-in');
  document.body.classList.add('has-banner');
}

export function hideBanner(): void {
  banner?.classList.remove('is-in');
  banner?.remove();
  banner = null;
  document.body.classList.remove('has-banner');
}
