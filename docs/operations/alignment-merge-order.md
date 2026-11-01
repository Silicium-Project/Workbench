# Ordre de fusion du réalignement

Relevé GitHub du 29 octobre 2026 (`gh`, `main` Workbench `b2cc2548`), complété
par l'état du 30 octobre ci-dessous. Les états
de PR changent vite : relire chacune avant de fusionner. Les dépendances entre
PR sont déduites des fichiers touchés, pas vérifiées dans les branches.

Règles communes : un humain fusionne, en **Merge commit**, quand `ci/required`
(ou `integration/required`) est vert sur le SHA exact et que la branche est à
jour. Sur les dépôts privés Free, cette règle n'est pas imposée par GitHub.
Une vague ne démarre qu'une fois la précédente fusionnée. Aucune étape ne
fusionne seule, ne pose un secret, une clé ou un pin.

## État au 30 octobre 2026

Relevé `gh` du 30 octobre, `main` Workbench `f911ed89` ; ce qui suit remplace
les états datés du 29 octobre ci-dessous.

| Vague | État |
| --- | --- |
| 0 | Faite. `ci.yml` vert sur `main` ; preuve de stockage fraîche sur le SHA exact. |
| 1 | Faite pour les docs et CODEOWNERS. Aucun runner auto-hébergé (organisation et sept dépôts). Reste : réglages de dépôt et de sécurité, humains. |
| 2 | Faite. Les cinq `main` natifs sont restaurés et repinnés sur la politique `7808d0f8`. |
| 3 | Faite : pins `f911ed89`, `components.lock.json` et gitlinks ensemble. |
| 4 | En cours. Première qualification (`41069910230`) : 16 suites sur 17, `solana` bloquée puis annulée ; seconde tentative refusée au plan. Le 1er novembre, `121d6600` a aussi été refusé au plan : deux `ci/required` sur le même SHA (push et relance manuelle). Relance sur un SHA neuf. Aucun reçu signé. |
| 5 et 6 | Non commencées : décisions et clés humaines. |

Le détail des blocages de la vague 4 est dans `docs/operations/automation-decisions.md`.

## Vague 0 : rendre `main` Workbench vert

Les trois derniers runs `CI` sur `main` échouent à l'étape
`Check organization artifact headroom` : la réserve de 392 Mio dépasse le
plafond de repli de 400 Mio.

1. Workbench #349 : plafond déclaré quand le plan est masqué. Précondition
   humaine : variable de dépôt `SILICIUM_ORG_ARTIFACT_LIMIT_MIB=512` (posée).
2. Workbench #348 : complément de la règle d'essai Enterprise.
3. Lancer `ci.yml` sur `main`, attendre `ci/required` et le contrôle de
   stockage, noter SHA et identifiant du run.
4. Relancer Network #355 dans les quinze minutes qui suivent : la preuve de
   stockage expire.

Sortie : run `main` vert sur le SHA qui contient #349 ; `plan_observed` lu dans
la sortie du contrôle.

## Vague 1 : politique Workbench (parallèle à la vague 2)

- Vérifier qu'aucun runner auto-hébergé n'existe au niveau organisation
  (`admin:org` requis, action humaine) et que `dev ci policy --json` rend un
  état propre.
- Fermer, après relecture humaine, les PR devenues sans objet : #345 (le
  runtime IA quitte Workbench avec #326), #159, #156.
- Activer `SILICIUM_COMPONENT_CI_ENABLED=1` composant par composant, seulement
  après la fusion de ses workflows. `SILICIUM_MIRROR_ENABLED` reste à `0`.

## Vague 2 : restauration des sources privées

Ordre imposé dans chaque dépôt : restauration, puis CI hébergé, puis issues.

| Dépôt | Ordre |
| --- | --- |
| Network | #355, puis #356 (mise à jour sur `main`, conflits probables dans `ci.yml`), puis #354 ; #255 à fermer |
| Solana | #1 (sans changer programme, ID ni autorités) |
| BackEnd | #39, puis #40, puis #38 ; trier #25, #26, #27 |
| FrontEnd | #28, puis #29, puis #27 ; reprendre ou fermer #15 |
| DesktopApp | #1, puis une PR du runtime IA privé issu de Workbench #326, puis #2 |

Après chaque fusion : vérifier que la tête de PR est ancêtre du `main` natif et
comparer avec la branche `dev` du composant pour reporter les commits absents.

## Vague 3 : pins, une seule PR

Une PR Workbench depuis `main` avec les cinq SHA des `main` natifs, gitlinks et
`components.lock.json` ensemble. Elle remplace #344 et #326, dont elle reprend
les changements utiles (planificateur qui garde les pins, suite
`network-contract`, retrait de `apps/silicium-ai-runtime`). Condition de sortie :
`dev workspace verify --materialized --json` vert, `ci/required` vert. Les pins
ne sont jamais ajustés par automatisation.

## Vague 4 : Integration

1. Integration #5 (réconciliation des pins), puis #4 (candidat de livraison) :
   les deux touchent `qualification.yml` et `pull-request.yml`.
2. Clé publique Ed25519 versionnée dans les deux dépôts, clé privée en secret
   Integration (action humaine).
3. Flags un par un : `SILICIUM_INTEGRATION_ENABLED`, puis
   `SILICIUM_DELIVERY_PREFLIGHT_ENABLED`, puis `SILICIUM_CANDIDATE_BUILD_ENABLED`.
4. Qualification manuelle sur le SHA Workbench de la vague 3, après relevé du
   compteur de minutes.

## Vague 5 : signature, publication, déploiement dev

Bloquée par des actions humaines : baseline de version, clés APT/RPM/release,
ancre `contracts/trust/release.gpg` (absente), App Publisher, secrets SSH
`development`, clé d'auto-update. Les PR de code (publication, déploiement,
rollback) suivent ces provisions et la fin de CI-10.

## Vague 6 : production

Décision humaine par promotion, après un déploiement dev et un rollback
démontrés. Aucune PR de code prévue.

## Dette

Fermer #315, #316 et #318 après avoir reporté les changements Go 1.27 et
Anchor 0.32.1 utiles dans BackEnd et Solana. Supprimer les branches Workbench
déjà fusionnées après vérification d'un écart nul avec `main`.
