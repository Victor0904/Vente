# Vide-grenier

Petite boutique de seconde main : catalogue → panier → commande avec paiement à la livraison, plus une interface de gestion protégée par mot de passe.
Hébergement gratuit sur **Netlify** : les annonces, commandes et photos sont stockées en JSON dans **Netlify Blobs**.

## Mettre en ligne (une seule fois)

1. **Créer le mot de passe admin** (Node.js 20+ requis sur votre PC) :
   ```bash
   npm install
   npm run hash-password            # ou : npm run hash-password -- --generate
   ```
   Le script affiche une valeur `scrypt:…`. Gardez-la de côté pour l'étape 4.
2. **Mettre le dossier sur GitHub** dans un nouveau dépôt. Les fichiers `.env`, `data/` et `node_modules/` sont exclus automatiquement.
3. **Sur Netlify** : *Add new site* → *Import an existing project* → GitHub → choisissez le dépôt.
   Il n'y a rien à remplir : la configuration est lue dans `netlify.toml`. Cliquez sur *Deploy*.
4. **Ajouter la variable du mot de passe** : *Site configuration* → *Environment variables* → *Add a variable* :
   - Key : `ADMIN_PASSWORD_HASH`
   - Value : la valeur `scrypt:…` de l'étape 1

   Relancez ensuite un déploiement : *Deploys* → *Trigger deploy*.

C'est en ligne :
- Boutique : `https://votre-site.netlify.app/`
- Gestion : `https://votre-site.netlify.app/admin/`

Les annonces que vous ajoutez et les commandes reçues apparaissent **immédiatement**, sans redéploiement.
Un redéploiement n'est nécessaire que si vous modifiez le code (design, textes…).

## Changer le mot de passe

Relancez `npm run hash-password`, remplacez la valeur de `ADMIN_PASSWORD_HASH` dans Netlify, puis redéployez.
Toutes les sessions ouvertes sont alors déconnectées.

## Tester en local avant de publier

```bash
npm install
npm run hash-password -- --local   # enregistre aussi le mot de passe dans .env
npm run dev                        # http://localhost:8888/  et  /admin/
```

En local, les données sont des fichiers JSON dans `data/`.

## Organisation

| Fichier | Rôle |
|---|---|
| `public/` | le site : boutique (`index.html`, `app.js`) et admin (`admin/`) |
| `lib/shop.mjs` | toute la logique : commandes, annonces, sécurité |
| `netlify/functions/api.mjs` | branche cette logique sur Netlify Blobs |
| `dev-server.mjs` | la même logique en local, avec des fichiers |

## Sécurité de l'admin

- Le mot de passe n'est stocké nulle part : seule une empreinte scrypt salée est conservée, dans une variable Netlify privée.
- Après 5 essais ratés, l'adresse IP est bloquée 15 minutes. Chaque échec ajoute aussi un délai.
- La session est un cookie signé (`HttpOnly`, `Secure`, `SameSite=Strict`) valable 8 h. Les requêtes venant d'un autre site sont refusées.
- Les commandes et les adresses des clients restent dans Netlify Blobs, jamais dans GitHub.
- Les photos sont vérifiées (vrai JPG/PNG/WebP), redimensionnées et débarrassées de leurs métadonnées (GPS) avant l'envoi.

Pas de stock à gérer : le client choisit la quantité (1 à 20 par article) et l'annonce reste en ligne jusqu'à ce que vous la supprimiez depuis l'admin. Les commandes gardent le titre, le prix et la quantité, même après suppression de l'annonce.
