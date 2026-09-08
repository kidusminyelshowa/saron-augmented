/**
 * MuralSelector
 *
 * Floating UI selector component that allows users to switch between available murals.
 */

export interface MuralItem {
  id: string;
  name: string;
  description?: string;
}

export interface MuralSelectorOptions {
  murals: MuralItem[];
  activeMuralId: string;
  onSelect: (muralId: string) => void;
}

export class MuralSelector {
  private container: HTMLDivElement;
  private selectEl: HTMLSelectElement;
  private options: MuralSelectorOptions;

  constructor(options: MuralSelectorOptions) {
    this.options = options;

    this.container = document.createElement('div');
    this.container.id = 'mural-selector';
    this.container.className = 'mural-selector';

    const label = document.createElement('span');
    label.className = 'mural-selector__label';
    label.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
        <circle cx="8.5" cy="8.5" r="1.5"></circle>
        <polyline points="21 15 16 10 5 21"></polyline>
      </svg>
    `;

    this.selectEl = document.createElement('select');
    this.selectEl.className = 'mural-selector__select';
    this.selectEl.ariaLabel = 'Select Mural Target';

    this.renderOptions();

    this.selectEl.addEventListener('change', () => {
      const selectedId = this.selectEl.value;
      if (selectedId && selectedId !== this.options.activeMuralId) {
        this.options.activeMuralId = selectedId;
        this.options.onSelect(selectedId);
      }
    });

    this.container.appendChild(label);
    this.container.appendChild(this.selectEl);
    document.body.appendChild(this.container);
  }

  private renderOptions(): void {
    this.selectEl.innerHTML = '';
    for (const mural of this.options.murals) {
      const opt = document.createElement('option');
      opt.value = mural.id;
      opt.textContent = mural.name;
      if (mural.id === this.options.activeMuralId) {
        opt.selected = true;
      }
      this.selectEl.appendChild(opt);
    }
  }

  public setActiveMural(muralId: string): void {
    this.options.activeMuralId = muralId;
    this.selectEl.value = muralId;
  }

  public destroy(): void {
    this.container.remove();
  }
}
