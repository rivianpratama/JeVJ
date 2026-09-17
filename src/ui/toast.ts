/**
 * Bottom-centre transient messages. One shared stack, newest at the bottom.
 */

let stack: HTMLElement | null = null;

function container(): HTMLElement {
  if (stack?.isConnected) return stack;
  stack = document.createElement('div');
  stack.className = 'toasts';
  stack.setAttribute('role', 'status');
  stack.setAttribute('aria-live', 'polite');
  document.body.append(stack);
  return stack;
}

export function toast(message: string, kind: 'info' | 'error' = 'info', ms = 3500): void {
  const el = document.createElement('div');
  el.className = `toast toast--${kind}`;
  el.textContent = message;
  container().append(el);

  // Force a style flush so the entry transition actually runs. rAF would do
  // it too, but rAF is paused in background tabs and the toast would never
  // fade in before its timer removed it.
  void el.offsetWidth;
  el.classList.add('is-in');

  const remove = (): void => el.remove();
  window.setTimeout(() => {
    el.classList.remove('is-in');
    el.addEventListener('transitionend', remove, { once: true });
    // Belt and braces: transitionend never fires if the tab is hidden.
    window.setTimeout(remove, 600);
  }, ms);
}
