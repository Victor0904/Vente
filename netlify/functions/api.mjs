// Fonction Netlify : toutes les routes /api/* passent ici. Les données sont dans Netlify Blobs.
import { getStore } from '@netlify/blobs';
import { createHandler } from '../../lib/shop.mjs';

function blobsStorage() {
  // « strong » : on relit toujours la dernière version (évite qu'une commande écrase une autre)
  const store = getStore({ name: 'boutique', consistency: 'strong' });
  return {
    async readJSON(key) {
      const r = await store.getWithMetadata(key, { type: 'json' });
      return r ? { value: r.data, etag: r.etag } : { value: null, etag: null };
    },
    async writeJSON(key, value, etag) {
      const options = etag === undefined ? {} : etag === null ? { onlyIfNew: true } : { onlyIfMatch: etag };
      return (await store.setJSON(key, value, options)).modified !== false;
    },
    async putFile(key, bytes, contentType) {
      await store.set(key, bytes, { metadata: { contentType } });
    },
    async getFile(key) {
      const r = await store.getWithMetadata(key, { type: 'arrayBuffer' });
      return r ? { bytes: r.data, contentType: r.metadata.contentType } : null;
    },
    remove: (key) => store.delete(key),
  };
}

export default async (req, context) => {
  const handle = createHandler(blobsStorage(), { env: { ADMIN_PASSWORD_HASH: Netlify.env.get('ADMIN_PASSWORD_HASH') }, secureCookie: true });
  return handle(req, { ip: context.ip });
};

export const config = { path: '/api/*' };
