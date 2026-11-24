// Sélecteur du rappel de prière : bouton + menu (Popover API, rendu au-dessus de tout).
// L'utilisateur choisit directement l'heure du rappel (HH:MM, heure du Maroc).
// Clavier : Entrée valide, Échap ferme.

/**
 * @param {{ trigger: HTMLButtonElement, label: HTMLElement, menu: HTMLElement,
 *           onChange: (atMins: number|null) => void }} opts
 *   onChange reçoit l'heure du rappel en minutes depuis minuit, ou null (désactivé).
 */
function createReminderPicker({ trigger, label, menu, onChange }) {
    const MENU_GAP_PX = 6;
    const VIEWPORT_MARGIN_PX = 8;
    let settings = { at: null, lead: null }; // cf. salatAlertSettings() (salat-core.js)

    const CHECK_SVG = '<svg class="reminder-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

    menu.innerHTML =
        '<p class="reminder-menu-title">Heure du rappel de prière</p>' +
        '<form class="reminder-lead-form" novalidate>' +
        '<input type="number" class="reminder-lead-input" name="hours" min="0" max="23" step="1" inputmode="numeric" placeholder="HH" aria-label="Heure du rappel">' +
        '<span class="reminder-time-sep" aria-hidden="true">:</span>' +
        '<input type="number" class="reminder-lead-input" name="mins" min="0" max="59" step="1" inputmode="numeric" placeholder="MM" aria-label="Minutes du rappel">' +
        '<button type="submit" class="reminder-lead-ok">OK</button>' +
        '</form>' +
        '<p class="reminder-lead-error" role="alert" hidden></p>' +
        '<div class="reminder-sep" role="separator"></div>' +
        `<button type="button" class="reminder-option reminder-off"><span class="reminder-option-text">Désactivé</span>${CHECK_SVG}</button>`;

    const form = menu.querySelector('.reminder-lead-form');
    const hoursInput = form.elements.hours;
    const minsInput = form.elements.mins;
    const errorEl = menu.querySelector('.reminder-lead-error');
    const offBtn = menu.querySelector('.reminder-off');

    const isOff = () => settings.at === null && settings.lead === null;
    const hhmm = (mins) => `${pad2(Math.floor(mins / 60))}:${pad2(mins % 60)}`;

    function showError(message) {
        errorEl.textContent = message;
        errorEl.hidden = !message;
        [hoursInput, minsInput].forEach((el) => el.classList.toggle('is-invalid', Boolean(message)));
    }

    function fillInputs() {
        if (settings.at !== null) {
            hoursInput.value = pad2(Math.floor(settings.at / 60));
            minsInput.value = pad2(settings.at % 60);
        } else {
            hoursInput.value = '';
            minsInput.value = '';
        }
        showError('');
    }

    function render() {
        if (settings.at !== null) label.textContent = `Rappel à ${hhmm(settings.at)}`;
        else if (settings.lead !== null) label.textContent = `Rappel ${settings.lead} min avant`;
        else label.textContent = 'Rappel désactivé';
        trigger.classList.toggle('is-off', isOff());
        offBtn.setAttribute('aria-pressed', String(isOff()));
    }

    function position() {
        const r = trigger.getBoundingClientRect();
        const width = menu.offsetWidth;
        const left = Math.min(r.left, window.innerWidth - width - VIEWPORT_MARGIN_PX);
        menu.style.top = `${r.bottom + MENU_GAP_PX}px`;
        menu.style.left = `${Math.max(VIEWPORT_MARGIN_PX, left)}px`;
    }

    function commit(at) {
        const changed = at !== settings.at || (at === null && !isOff());
        settings = { at, lead: null };
        render();
        menu.hidePopover();
        if (changed) onChange(at);
    }

    form.addEventListener('submit', (e) => {
        e.preventDefault();
        if (hoursInput.value === '') return showError('Saisissez l\'heure du rappel.');
        const h = Number(hoursInput.value);
        const m = minsInput.value === '' ? 0 : Number(minsInput.value);
        if (!Number.isInteger(h) || h < 0 || h > 23 || !Number.isInteger(m) || m < 0 || m > 59) {
            return showError('Heure invalide (00:00 à 23:59).');
        }
        commit(h * 60 + m);
    });

    [hoursInput, minsInput].forEach((el) => {
        el.addEventListener('input', () => showError(''));
        el.addEventListener('focus', () => el.select());
    });
    // Deux chiffres saisis pour l'heure → passage automatique aux minutes
    hoursInput.addEventListener('input', () => {
        if (hoursInput.value.length >= 2) minsInput.focus();
    });

    offBtn.addEventListener('click', () => commit(null));

    menu.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            menu.hidePopover();
        }
    });

    menu.addEventListener('toggle', (e) => {
        const isOpen = e.newState === 'open';
        trigger.setAttribute('aria-expanded', String(isOpen));
        if (isOpen) {
            fillInputs();
            position();
            hoursInput.focus({ preventScroll: true });
        } else if (menu.contains(document.activeElement) || document.activeElement === document.body) {
            trigger.focus({ preventScroll: true });
        }
    });

    // Flèche bas sur le bouton : ouvre directement le menu
    trigger.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            menu.showPopover();
        }
    });

    render();

    return {
        /** @param {{ at: number|null, lead: number|null }} value */
        setValue(value) {
            settings = { at: value.at, lead: value.lead };
            render();
        }
    };
}
