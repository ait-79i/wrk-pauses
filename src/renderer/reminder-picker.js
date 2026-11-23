// Sélecteur « Rappel avant la prière » : bouton + menu (Popover API, rendu au-dessus de tout).
// Accessible au clavier : flèches, Début/Fin, Entrée/Espace, Échap.

/**
 * @param {{ trigger: HTMLButtonElement, label: HTMLElement, menu: HTMLElement,
 *           choices: number[], onChange: (lead: number|null) => void }} opts
 */
function createReminderPicker({ trigger, label, menu, choices, onChange }) {
    const MENU_GAP_PX = 6;
    const VIEWPORT_MARGIN_PX = 8;
    const options = [...choices.map((m) => ({ value: m, text: `${m} min avant` })), { value: null, text: 'Désactivé' }];
    let current = null;

    const CHECK_SVG = '<svg class="reminder-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

    function optionId(value) {
        return `reminder-opt-${value === null ? 'off' : value}`;
    }

    function build() {
        const title = document.createElement('p');
        title.className = 'reminder-menu-title';
        title.textContent = 'Me prévenir avant chaque prière';
        menu.appendChild(title);

        for (const opt of options) {
            if (opt.value === null) {
                menu.appendChild(buildCustomRow());
                const sep = document.createElement('div');
                sep.className = 'reminder-sep';
                sep.setAttribute('role', 'separator');
                menu.appendChild(sep);
            }
            const item = document.createElement('div');
            item.className = 'reminder-option';
            item.id = optionId(opt.value);
            item.setAttribute('role', 'option');
            item.dataset.value = opt.value === null ? 'off' : String(opt.value);
            item.innerHTML = `<span class="reminder-option-text"></span>${CHECK_SVG}`;
            item.querySelector('.reminder-option-text').textContent = opt.text;
            item.addEventListener('click', () => select(opt.value));
            item.addEventListener('mousemove', () => setActive(item));
            menu.appendChild(item);
        }
    }

    // Durée personnalisée : saisie libre en minutes (1 à 120)
    const CUSTOM_MIN = 1;
    const CUSTOM_MAX = 120;
    let customInput = null;
    let customRow = null;

    function buildCustomRow() {
        customRow = document.createElement('div');
        customRow.className = 'reminder-option reminder-custom';
        customRow.id = 'reminder-opt-custom';
        customRow.setAttribute('role', 'option');
        customRow.dataset.value = 'custom';
        customRow.innerHTML =
            '<span class="reminder-option-text">Personnalisé</span>' +
            '<span class="reminder-custom-field">' +
            `<input type="number" class="reminder-custom-input" min="${CUSTOM_MIN}" max="${CUSTOM_MAX}" step="1" inputmode="numeric" aria-label="Minutes avant la prière">` +
            '<span class="reminder-custom-unit">min</span>' +
            '<button type="button" class="reminder-custom-ok" aria-label="Valider le rappel personnalisé">OK</button>' +
            '</span>' + CHECK_SVG;
        customInput = customRow.querySelector('.reminder-custom-input');

        const submit = () => {
            const n = Math.round(Number(customInput.value));
            if (!Number.isFinite(n) || n < CUSTOM_MIN || n > CUSTOM_MAX) {
                customInput.classList.add('is-invalid');
                customInput.focus();
                return;
            }
            customInput.classList.remove('is-invalid');
            select(n);
        };

        customRow.addEventListener('click', (e) => {
            if (e.target.closest('.reminder-custom-ok')) return submit();
            if (e.target !== customInput) customInput.focus();
        });
        customRow.addEventListener('mousemove', () => setActive(customRow));
        customInput.addEventListener('input', () => customInput.classList.remove('is-invalid'));
        customInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                submit();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                menu.hidePopover();
            }
            e.stopPropagation(); // la saisie ne doit pas déplacer la sélection du menu
        });
        return customRow;
    }

    const isCustom = (value) => value !== null && !choices.includes(value);

    const items = () => [...menu.querySelectorAll('.reminder-option')];

    function setActive(item) {
        items().forEach((el) => el.classList.toggle('is-active', el === item));
        menu.setAttribute('aria-activedescendant', item.id);
        item.scrollIntoView({ block: 'nearest' });
    }

    function render() {
        label.textContent = current === null ? 'Rappel désactivé' : `Rappel ${current} min avant`;
        trigger.classList.toggle('is-off', current === null);
        const selectedId = isCustom(current) ? customRow.id : optionId(current);
        items().forEach((el) => {
            el.setAttribute('aria-selected', String(el.id === selectedId));
        });
        if (document.activeElement !== customInput) {
            customInput.value = isCustom(current) ? String(current) : '';
            customInput.placeholder = String(current ?? DEFAULT_CUSTOM_PLACEHOLDER);
        }
    }

    const DEFAULT_CUSTOM_PLACEHOLDER = 25;

    function position() {
        const r = trigger.getBoundingClientRect();
        const width = menu.offsetWidth;
        const left = Math.min(r.left, window.innerWidth - width - VIEWPORT_MARGIN_PX);
        menu.style.top = `${r.bottom + MENU_GAP_PX}px`;
        menu.style.left = `${Math.max(VIEWPORT_MARGIN_PX, left)}px`;
    }

    function select(value) {
        const changed = value !== current;
        current = value;
        render();
        menu.hidePopover();
        if (changed) onChange(value);
    }

    menu.addEventListener('toggle', (e) => {
        const isOpen = e.newState === 'open';
        trigger.setAttribute('aria-expanded', String(isOpen));
        if (isOpen) {
            position();
            setActive(isCustom(current) ? customRow : (menu.querySelector(`#${optionId(current)}`) || items()[0]));
            menu.focus({ preventScroll: true });
        } else if (menu.contains(document.activeElement) || document.activeElement === document.body) {
            trigger.focus({ preventScroll: true });
        }
    });

    menu.addEventListener('keydown', (e) => {
        const list = items();
        const i = list.findIndex((el) => el.classList.contains('is-active'));
        const moves = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: list.length - 1 };
        if (e.key in moves) {
            e.preventDefault();
            setActive(list[(moves[e.key] + list.length) % list.length]);
        } else if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            const active = list[i];
            if (!active) return;
            if (active === customRow) customInput.focus();
            else select(active.dataset.value === 'off' ? null : Number(active.dataset.value));
        } else if (e.key === 'Tab') {
            menu.hidePopover();
        }
    });

    // Flèche bas sur le bouton : ouvre directement le menu
    trigger.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            menu.showPopover();
        }
    });

    build();
    render();

    return {
        setValue(value) {
            current = value;
            render();
        }
    };
}
