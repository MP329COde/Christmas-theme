# Feuille de route des améliorations visuelles

Le sapin de Noël est validé et reste volontairement hors du périmètre de cette feuille de route.

## Terminé : cheminée classique et réglages détaillés

- Nouveau style par défaut « classique » : conduit en briques à joints décalés, linteau, foyer cerclé de fonte noirci par la suie, chenets, bûches, manteau peint sur corbeaux et dalle de marbre.
- Réglages par cheminée : intensité du feu (braises à brasier), teinte des briques (rouges, ocre, gris pierre, blanches) et couleur du manteau.
- Les styles « rustique » et « moderne » restent disponibles.

## Terminé : installation personnalisée

- Assistant de première utilisation : ambiance, quantité de neige, Dock, démarrage automatique et volume.
- Installateur Windows en français (licence, images, nettoyage du démarrage automatique) et image disque macOS personnalisée.

## Terminé : profils de palette de l'aurore

- Les choix de palette par écran adaptent l'aurore à la scène sans modifier son budget d'animation.
- Canvas 2D et WebGL utilisent la même palette : le repli de moteur conserve donc l'apparence choisie.
- Le profil choisi est enregistré avec la composition de l'écran.

## Terminé : profils météo

- Les profils météo par écran coordonnent la taille des flocons, le vent, l'épaisseur du dépôt et la densité de scintillement de la neige.
- Ils modulent les réglages globaux de neige : la préférence de base est conservée, mais chaque écran a sa propre météo.
- Le profil est enregistré avec la composition de l'écran et les préréglages.

## Terminé : densité du ciel et fréquence des étoiles filantes

- Des réglages par écran ajustent la densité du champ d'étoiles et la cadence des étoiles filantes.
- Une fréquence nulle désactive les comètes sans désactiver les étoiles.

## Terminé : profils de mouvement de caméra

- Du cadrage fixe à la dérive immersive, par écran, en préservant les valeurs existantes.
- Le profil « système » respecte la préférence de réduction des animations du système.

## Terminé : éditeur d'éclairage

- Chaleur ambiante, halation et contribution de la cheminée par écran, en préservant l'apparence par défaut.
- La lueur de la cheminée (Canvas) et l'éclairage des sapins (WebGL) utilisent la même contribution.

## Terminé : vignettes des préréglages

- L'enregistrement d'un préréglage génère une petite vignette stylisée (ciel, aurore, neige, sapins, lueur de la cheminée).
- La barre des préréglages affiche la vignette du préréglage sélectionné.

## Terminé : diagnostic de performance

- Le panneau Système affiche un graphique des temps d'image (rouge au-delà du budget du gouverneur de qualité) à côté du compteur d'images par seconde.
- Une explication en clair nomme le palier de qualité actif et, si les sapins sont repassés sur Canvas 2D, pourquoi.

## Prochaines étapes

- Ajouter une couverture de régression visuelle pour chaque palette du ciel et chaque palier de qualité dégradé.
- Ajouter une capture des nouvelles teintes de cheminée aux tests visuels.
