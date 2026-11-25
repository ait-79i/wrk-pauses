// Écran plein écran « Choisissez votre groupe », ouvert sur chaque moniteur dès que les horaires
// d'une prière sont publiés et que le membre n'a pas de groupe. Il se ferme (processus principal)
// dès qu'un choix est enregistré, ou quand le membre indique qu'il ne prie pas avec un groupe.
// Données : psStore (teamDay, team, isRamadanMode) ; actions : psTeam.choose / psTeam.dismissChoice.
// Texte du serveur inséré uniquement en nœuds texte.

(function () {
    const ARABIC = { DHUHR: 'صلاة الظهر', ASR: 'صلاة العصر' };
    const LATIN = { DHUHR: 'Dhuhr', ASR: 'Asr' };

    const params = new URLSearchParams(location.search);
    const date = params.get('date');
    const prayer = params.get('prayer');

    const app = document.getElementById('chooseApp');
    const groupsEl = document.getElementById('chooseGroups');
    const errorEl = document.getElementById('chooseError');
    const skipBtn = document.getElementById('chooseSkip');
    let teamDay = null;
    let busy = false;

    const hhmm = (mins) => `${pad2(Math.floor(mins / 60))}:${pad2(mins % 60)}`;

    function showError(message) {
        errorEl.textContent = message || '';
        errorEl.hidden = !message;
    }

    function render() {
        document.getElementById('choosePrayerAr').textContent = ARABIC[prayer] || '';
        document.getElementById('chooseTitle').textContent = `Avec quel groupe priez-vous ${LATIN[prayer] || ''} ?`;
        const p = teamDay && teamDay.date === date ? teamDay.prayers.find((x) => x.prayer === prayer) : null;
        const nowMins = teamDay ? Math.floor(moroccoNowSecs() / 60) : 0;
        document.getElementById('chooseSub').textContent = p
            ? 'Les horaires du jour sont publiés. Votre rappel suivra l\'heure du groupe choisi.'
            : 'Chargement des horaires…';

        groupsEl.replaceChildren();
        for (const s of (p ? p.slots : [])) {
            const past = s.timeMins <= nowMins;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'choose-group';
            btn.disabled = busy || past;
            const name = document.createElement('span');
            name.className = 'choose-group-name';
            name.textContent = s.groupName;
            const time = document.createElement('span');
            time.className = 'choose-group-time';
            time.textContent = hhmm(s.timeMins);
            const count = document.createElement('span');
            count.className = 'choose-group-count';
            count.textContent = past ? 'Heure passée' : `${s.count} inscrit${s.count > 1 ? 's' : ''}`;
            btn.append(name, time, count);
            btn.setAttribute('aria-label', `${s.groupName} à ${hhmm(s.timeMins)}, ${count.textContent}`);
            btn.addEventListener('click', () => choose(s.groupId));
            groupsEl.append(btn);
        }
        skipBtn.disabled = busy;
        const first = groupsEl.querySelector('button:not(:disabled)');
        if (first && !app.contains(document.activeElement)) first.focus();
    }

    async function choose(groupId) {
        if (busy) return;
        busy = true;
        showError('');
        render();
        const res = await window.psTeam.choose(date, prayer, groupId);
        busy = false;
        if (!res || !res.ok) {
            showError(res && res.message ? res.message : 'Choix impossible. Vérifiez votre connexion et réessayez.');
            render();
        }
        // Succès : le processus principal ferme l'écran dès la mise à jour des horaires
    }

    skipBtn.addEventListener('click', async () => {
        if (busy) return;
        busy = true;
        render();
        // « Aucun groupe » enregistré sur le serveur ; mémorisé aussi sur cet ordinateur si le serveur est injoignable
        await window.psTeam.choose(date, prayer, null).catch(() => null);
        await window.psTeam.dismissChoice(date, prayer);
    });

    // Écran figé : Échap et les raccourcis de fermeture ne le ferment pas
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' || (e.altKey && e.key === 'F4')) e.preventDefault();
    });

    window.psStore.get(['teamDay', 'isRamadanMode']).then((res) => {
        teamDay = res.teamDay || null;
        app.classList.toggle('ramadan-active', Boolean(res.isRamadanMode));
        render();
    });
    window.psStore.onChanged((changes) => {
        if (changes.teamDay) teamDay = changes.teamDay.newValue || null;
        if (changes.isRamadanMode) app.classList.toggle('ramadan-active', Boolean(changes.isRamadanMode.newValue));
        if (!busy) render();
    });
    // Les heures qui passent désactivent les groupes concernés
    setInterval(() => { if (!busy) render(); }, 30_000);
})();
