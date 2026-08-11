/**
 * Overlay
 *
 * Manages the full-screen UI overlay for loading, scanning prompts,
 * error states, and status messages. States auto-dismiss when no
 * longer relevant.
 */

export type OverlayState =
  | 'loading'
  | 'scanning'
  | 'tap-to-start'
  | 'camera-denied'
  | 'tracking-lost'
  | 'unsupported'
  | 'hidden';

const MESSAGES: Record<Exclude<OverlayState, 'hidden'>, { title: string; subtitle: string }> = {
  loading: {
    title: 'Preparing the artwork…',
    subtitle: 'Setting up your AR experience',
  },
  'tap-to-start': {
    title: 'Tap anywhere to begin',
    subtitle: 'Your camera will activate to find the mural',
  },
  scanning: {
    title: 'Point your camera at the mural',
    subtitle: 'Hold steady until the artwork comes alive',
  },
  'camera-denied': {
    title: 'Camera access is required',
    subtitle: 'Please enable camera permissions and reload the page',
  },
  'tracking-lost': {
    title: 'Move your camera back toward the mural',
    subtitle: 'We lost sight of the artwork',
  },
  unsupported: {
    title: 'Browser not supported',
    subtitle: 'This experience works best in Safari on iPhone and Chrome on Android',
  },
};

export class Overlay {
  private el: HTMLDivElement;
  private titleEl: HTMLHeadingElement;
  private subtitleEl: HTMLParagraphElement;
  private spinnerEl: HTMLDivElement;
  private currentState: OverlayState = 'hidden';

  constructor() {
    // Create overlay container
    this.el = document.createElement('div');
    this.el.id = 'ar-overlay';
    this.el.className = 'ar-overlay';

    // Inner content wrapper
    const content = document.createElement('div');
    content.className = 'ar-overlay__content';

    // Spinner
    this.spinnerEl = document.createElement('div');
    this.spinnerEl.className = 'ar-overlay__spinner';
    this.spinnerEl.innerHTML = `
      <svg viewBox="0 0 50 50" class="ar-overlay__spinner-svg">
        <circle cx="25" cy="25" r="20" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" />
      </svg>
    `;

    // Title
    this.titleEl = document.createElement('h2');
    this.titleEl.className = 'ar-overlay__title';

    // Subtitle
    this.subtitleEl = document.createElement('p');
    this.subtitleEl.className = 'ar-overlay__subtitle';

    content.appendChild(this.spinnerEl);
    content.appendChild(this.titleEl);
    content.appendChild(this.subtitleEl);
    this.el.appendChild(content);

    document.body.appendChild(this.el);

    this.hide();
  }

  /** Show a specific overlay state. */
  show(state: Exclude<OverlayState, 'hidden'>): void {
    this.currentState = state;
    const msg = MESSAGES[state];

    this.titleEl.textContent = msg.title;
    this.subtitleEl.textContent = msg.subtitle;

    // Only show spinner for loading and scanning states
    this.spinnerEl.style.display =
      state === 'loading' || state === 'scanning' ? 'block' : 'none';

    // Add state class for conditional styling
    this.el.className = `ar-overlay ar-overlay--${state}`;
    this.el.style.display = 'flex';

    // Force reflow, then add visible class for CSS transition
    void this.el.offsetHeight;
    this.el.classList.add('ar-overlay--visible');
  }

  /** Hide the overlay. */
  hide(): void {
    this.currentState = 'hidden';
    this.el.classList.remove('ar-overlay--visible');

    // Wait for CSS transition to finish before hiding
    setTimeout(() => {
      if (this.currentState === 'hidden') {
        this.el.style.display = 'none';
      }
    }, 400);
  }

  /** Get the current overlay state. */
  getState(): OverlayState {
    return this.currentState;
  }

  /** Remove the overlay from the DOM entirely. */
  destroy(): void {
    this.el.remove();
  }
}
