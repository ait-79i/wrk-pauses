# Le serveur d'équipes ne connaît pas les pauses

Le serveur (Node/TypeScript + MySQL, déployé par Docker sur Coolify) ne gère que les équipes, catégories, groupes, horaires du jour, choix de groupe et discussions. Les pauses, l'heure d'arrivée et l'heure de sortie restent sur l'ordinateur du membre, synchronisées comme avant par son propre dossier (Google Drive ou local). Ce choix limite les données personnelles centralisées : ni les admins ni le super admin ne voient le temps de pause de quiconque.
