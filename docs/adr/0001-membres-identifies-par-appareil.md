# Les membres sont identifiés par leur appareil, sans mot de passe

Pour rejoindre une équipe, un membre saisit seulement son nom et un code d'accès ; l'application reçoit une clé secrète liée à l'ordinateur, qui sert d'identité. On a écarté l'email + mot de passe pour garder l'adhésion aussi simple qu'aujourd'hui sur Teams. Les risques (usurpation de nom, changement de PC) sont couverts par des noms uniques par équipe, une validation optionnelle des nouveaux membres par un admin et un code de transfert à usage unique. Seuls le super admin (avec 2FA) et les admins (email + mot de passe) se connectent au tableau de bord web.

## Consequences

- Perdre l'ordinateur sans code de transfert revient à perdre le compte : l'admin doit en recréer un ou transférer l'historique.
- Passer plus tard à des comptes avec mot de passe demandera une migration de tous les membres existants.
