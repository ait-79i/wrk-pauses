// Page Réglages : édite les règles de la journée (mode normal et mode Ramadan) et les
// enregistre sous la clé dayRulesConfig, lue par day-core.js (applyDayRulesConfig).
// Dépend de salat-core.js (timeToMins, minsToHM) et day-core.js (DEFAULT_DAY_RULES, DAY_RULE_FIELDS).

const form = document.getElementById('rulesForm');
const errorEl = document.getElementById('formError');
const savedNote = document.getElementById('savedNote');
const modeCards = { normal: form.querySelector('[data-mode="normal"]'), ramadan: form.querySelector('[data-mode="ramadan"]') };

// Durées comme heures : 480 min ↔ "08:00". minsToHM borne à 24 h, ce qui suffit ici.
function minsToInput(mins) {
    return minsToHM(mins);
}
function inputToMins(value) {
    const m = timeToMins(value);
    return Number.isNaN(m) ? null : m;
}

/** Remplit les champs d'un mode à partir d'un objet de règles (minutes) */
function fillMode(mode, rules) {
    const card = modeCards[mode];
    DAY_RULE_FIELDS.forEach((field) => {
        card.querySelector(`[name="${field}"]`).value = minsToInput(rules[field]);
    });
}

function fillForm(config) {
    ['normal', 'ramadan'].forEach((mode) => {
        const base = DEFAULT_DAY_RULES[mode];
        const user = (config && config[mode]) || {};
        const rules = {};
        DAY_RULE_FIELDS.forEach((f) => {
            rules[f] = typeof user[f] === 'number' && Number.isFinite(user[f]) ? user[f] : base[f];
        });
        fillMode(mode, rules);
    });
}

function clearInvalid() {
    form.querySelectorAll('.is-invalid').forEach((el) => el.classList.remove('is-invalid'));
    errorEl.textContent = '';
}

/** Lit et valide un mode ; renvoie { rules } ou { error, field } */
function readMode(mode) {
    const card = modeCards[mode];
    const rules = {};
    for (const field of DAY_RULE_FIELDS) {
        const input = card.querySelector(`[name="${field}"]`);
        const mins = inputToMins(input.value);
        if (mins === null) return { error: 'Remplissez tous les champs (heures valides).', input };
        rules[field] = mins;
    }
    if (rules.workMins <= 0) return { error: 'La durée de travail doit être supérieure à zéro.', input: card.querySelector('[name="workMins"]') };
    if (rules.maxOut < rules.minOut) return { error: 'La sortie au plus tard doit être postérieure (ou égale) à la sortie au plus tôt.', input: card.querySelector('[name="maxOut"]') };
    return { rules };
}

function labelFor(mode) {
    return mode === 'ramadan' ? 'Ramadan' : 'normal';
}

function showSaved() {
    savedNote.textContent = 'Enregistré';
    savedNote.classList.add('is-shown');
    setTimeout(() => savedNote.classList.remove('is-shown'), 2200);
}

form.addEventListener('input', clearInvalid);

form.addEventListener('submit', (e) => {
    e.preventDefault();
    clearInvalid();
    const config = {};
    for (const mode of ['normal', 'ramadan']) {
        const res = readMode(mode);
        if (res.error) {
            errorEl.textContent = `Mode ${labelFor(mode)} : ${res.error}`;
            if (res.input) { res.input.classList.add('is-invalid'); res.input.focus(); }
            return;
        }
        config[mode] = res.rules;
    }
    chrome.storage.local.set({ [DAY_RULES_KEY]: config }, showSaved);
});

document.getElementById('resetBtn').addEventListener('click', () => {
    clearInvalid();
    fillForm(null); // recharge les valeurs par défaut dans les champs
    chrome.storage.local.remove(DAY_RULES_KEY, () => {
        savedNote.textContent = 'Réinitialisé';
        savedNote.classList.add('is-shown');
        setTimeout(() => savedNote.classList.remove('is-shown'), 2200);
    });
});

// Démarrage automatique avec Windows : seulement dans l'application (window.psSystem).
// Dans l'extension de navigateur, cette API n'existe pas → section masquée.
const startupSection = document.getElementById('startupSection');
const autoLaunchToggle = document.getElementById('autoLaunch');
if (window.psSystem && startupSection) {
    startupSection.hidden = false;
    window.psSystem.getAutoLaunch()
        .then((on) => { autoLaunchToggle.checked = Boolean(on); })
        .catch(() => { /* indisponible : la case reste décochée */ });
    autoLaunchToggle.addEventListener('change', () => {
        window.psSystem.setAutoLaunch(autoLaunchToggle.checked)
            .then((on) => { autoLaunchToggle.checked = Boolean(on); })
            .catch(() => { /* échec : on ne bloque pas l'utilisateur */ });
    });
}

// Mode plein écran pour les pauses
const fullscreenPauseToggle = document.getElementById('fullscreenPauseToggle');
if (fullscreenPauseToggle) {
    chrome.storage.local.get('fullscreenPause', (res) => {
        fullscreenPauseToggle.checked = res.fullscreenPause !== false;
    });
    fullscreenPauseToggle.addEventListener('change', () => {
        chrome.storage.local.set({ fullscreenPause: fullscreenPauseToggle.checked }, showSaved);
    });
}

// Affichage du bandeau de la prochaine prière dans la fenêtre principale
const showSalatToggle = document.getElementById('showSalatToggle');
if (showSalatToggle) {
    chrome.storage.local.get('showSalat', (res) => {
        showSalatToggle.checked = res.showSalat !== false;
    });
    showSalatToggle.addEventListener('change', () => {
        chrome.storage.local.set({ showSalat: showSalatToggle.checked }, showSaved);
    });
}

// Chargement initial
chrome.storage.local.get(DAY_RULES_KEY, (res) => fillForm(res[DAY_RULES_KEY]));

// ------------------------------------------------------------- Synchronisation (Google Drive & Dossier local)

const syncSection = document.getElementById('syncSection');
if (window.psSync && syncSection) {
    syncSection.hidden = false;

    const syncStatusPill = document.getElementById('syncStatusPill');
    const syncNowBtn = document.getElementById('syncNowBtn');
    const syncNowBtnText = document.getElementById('syncNowBtnText');
    const syncIcon = document.getElementById('syncIcon');
    const syncAutoToggle = document.getElementById('syncAutoToggle');
    const syncLastTimeLabel = document.getElementById('syncLastTimeLabel');
    const syncDetailMessage = document.getElementById('syncDetailMessage');
    const syncFolderPath = document.getElementById('syncFolderPath');
    const browseFolderBtn = document.getElementById('browseFolderBtn');
    const openFolderBtn = document.getElementById('openFolderBtn');
    const exportPackageBtn = document.getElementById('exportPackageBtn');
    const importPackageFile = document.getElementById('importPackageFile');

    function formatSyncTime(ts) {
        if (!ts) return 'Jamais';
        const d = new Date(ts);
        const now = Date.now();
        const diffSecs = Math.round((now - ts) / 1000);
        if (diffSecs < 60) return "À l'instant";
        if (diffSecs < 3600) return `Il y a ${Math.floor(diffSecs / 60)} min`;
        return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} à ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }

    function renderSyncStatus(status) {
        if (!status) return;
        const { isSyncing, lastSyncTime, lastSyncStatus, lastSyncError, lastSyncMergedCount } = status;

        syncLastTimeLabel.textContent = formatSyncTime(lastSyncTime);
        syncIcon.classList.toggle('spinner-icon', Boolean(isSyncing));
        syncNowBtn.disabled = Boolean(isSyncing);
        syncNowBtnText.textContent = isSyncing ? 'Synchronisation...' : 'Synchroniser maintenant';

        syncStatusPill.className = 'update-status-pill';
        if (isSyncing) {
            syncStatusPill.classList.add('update-status-pill--checking');
            syncStatusPill.textContent = 'En cours...';
            syncDetailMessage.textContent = 'Synchronisation bidirectionnelle en cours...';
            syncDetailMessage.style.color = 'var(--muted)';
        } else if (lastSyncStatus === 'error') {
            syncStatusPill.classList.add('update-status-pill--error');
            syncStatusPill.textContent = 'Erreur';
            syncDetailMessage.textContent = `Échec : ${lastSyncError || 'Erreur inconnue'}`;
            syncDetailMessage.style.color = 'var(--pomegranate)';
        } else if (lastSyncStatus === 'success') {
            syncStatusPill.classList.add('update-status-pill--latest');
            syncStatusPill.textContent = 'Synchronisé';
            const count = typeof lastSyncMergedCount === 'number' ? ` (${lastSyncMergedCount} journées traitées)` : '';
            syncDetailMessage.textContent = `Synchronisation réussie avec succès${count}.`;
            syncDetailMessage.style.color = 'var(--mint)';
        } else {
            syncStatusPill.classList.add('update-status-pill--latest');
            syncStatusPill.textContent = 'Prêt';
            syncDetailMessage.textContent = '';
        }
    }

    function updateFolderUi(folder) {
        if (syncFolderPath) syncFolderPath.value = folder || '';
        if (openFolderBtn) openFolderBtn.style.display = folder ? 'inline-flex' : 'none';
    }

    // Chargement de la configuration initiale
    window.psSync.getConfig().then((cfg) => {
        syncAutoToggle.checked = Boolean(cfg.autoSync);
        updateFolderUi(cfg.folderPath);
    });

    window.psSync.getStatus().then((status) => {
        renderSyncStatus(status);
        if (status && status.config) updateFolderUi(status.config.folderPath);
    });
    window.psSync.onStatusChange(renderSyncStatus);

    // Bascule auto-sync
    syncAutoToggle.addEventListener('change', () => {
        window.psSync.saveConfig({ autoSync: syncAutoToggle.checked, enabled: true });
    });

    // Choix du dossier local ou Google Drive
    browseFolderBtn.addEventListener('click', async () => {
        try {
            const folder = await window.psSync.chooseFolder();
            if (folder) {
                updateFolderUi(folder);
                window.psSync.saveConfig({ folderPath: folder, enabled: true });
                // Lancer une première synchronisation immédiate pour tester le dossier
                syncNowBtn.click();
            }
        } catch (err) {
            console.error('Erreur sélection dossier :', err);
        }
    });

    // Ouvrir le dossier sélectionné dans l'Explorateur Windows
    if (openFolderBtn) {
        openFolderBtn.addEventListener('click', () => {
            const folder = syncFolderPath ? syncFolderPath.value : '';
            if (folder && window.psSync.openFolder) {
                window.psSync.openFolder(folder);
            }
        });
    }

    // Déclenchement de la synchronisation
    syncNowBtn.addEventListener('click', async () => {
        if (!syncFolderPath.value) {
            browseFolderBtn.click();
            return;
        }
        try {
            syncDetailMessage.textContent = 'Démarrage de la synchronisation...';
            syncDetailMessage.style.color = 'var(--muted)';
            const res = await window.psSync.syncNow();
            if (!res.ok) {
                syncDetailMessage.textContent = `Erreur : ${res.error || 'Échec de synchronisation'}`;
                syncDetailMessage.style.color = 'var(--pomegranate)';
            }
        } catch (err) {
            console.error('Erreur déclenchement synchro :', err);
            syncDetailMessage.textContent = `Erreur : ${err.message || err}`;
            syncDetailMessage.style.color = 'var(--pomegranate)';
        }
    });

    // Exportation du paquet de sauvegarde
    exportPackageBtn.addEventListener('click', async () => {
        try {
            const jsonStr = await window.psSync.exportPackage();
            const dateStr = new Date().toISOString().slice(0, 10);
            const blob = new Blob([jsonStr], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `pause_backup_${dateStr}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } catch (err) {
            console.error('Erreur export sauvegarde :', err);
            alert(`Erreur lors de l'export : ${err.message || err}`);
        }
    });

    // Importation du paquet de sauvegarde
    importPackageFile.addEventListener('change', (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async (evt) => {
            try {
                const text = String(evt.target.result || '');
                const res = await window.psSync.importPackage(text);
                if (res.ok) {
                    alert(`Restauration réussie ! ${res.mergedDaysCount || 0} journées d'historique fusionnées.`);
                    location.reload();
                } else {
                    alert(`Échec de l'importation : ${res.error || 'Format non reconnu'}`);
                }
            } catch (err) {
                console.error('Erreur import paquet :', err);
                alert(`Erreur d'import : ${err.message || err}`);
            } finally {
                importPackageFile.value = '';
            }
        };
        reader.readAsText(file);
    });
}

