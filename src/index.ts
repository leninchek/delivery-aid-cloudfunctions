import { onRequest } from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';

admin.initializeApp();

const FCM_CHUNK_SIZE = 500;
const FIRESTORE_IN_LIMIT = 30;
const FIRESTORE_BATCH_LIMIT = 500;

const VALID_TARGETS = new Set(['all', 'level_ids']);

const STALE_TOKEN_CODES = new Set([
  'messaging/invalid-registration-token',
  'messaging/registration-token-not-registered',
  'messaging/mismatched-credential',
]);

function chunk<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

async function cleanStaleTokens(staleTokens: string[]): Promise<void> {
  if (staleTokens.length === 0) return;

  // Query in chunks of 30 (Firestore 'in' limit)
  const tokenChunks = chunk(staleTokens, FIRESTORE_IN_LIMIT);
  const snapshots = await Promise.all(
    tokenChunks.map(tokenChunk =>
      admin.firestore().collection('AppDevices')
        .where('fcmToken', 'in', tokenChunk)
        .get()
    )
  );

  const allDocs = snapshots.flatMap(s => s.docs);

  // Commit in batches of 500 (Firestore batch limit)
  const docChunks = chunk(allDocs, FIRESTORE_BATCH_LIMIT);
  await Promise.all(
    docChunks.map(docChunk => {
      const batch = admin.firestore().batch();
      docChunk.forEach(doc => {
        batch.update(doc.ref, {
          fcmToken: null,
          active: false,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      });
      return batch.commit();
    })
  );

  console.log('[sendPushCampaign] Cleaned stale tokens:', staleTokens.length);
}

async function queryTokens(target: string, targetLevelIds: string[]): Promise<string[]> {
  const seenTokens = new Set<string>();

  if (target === 'level_ids') {
    // Chunk levelIds to stay under the Firestore 'in' limit of 30
    const levelChunks = chunk(targetLevelIds, FIRESTORE_IN_LIMIT);
    const snapshots = await Promise.all(
      levelChunks.map(levelChunk =>
        admin.firestore().collection('AppDevices')
          .where('active', '==', true)
          .where('orgLevelId', 'in', levelChunk)
          .get()
      )
    );
    snapshots.flatMap(s => s.docs).forEach(doc => {
      const token = doc.data().fcmToken as string | undefined;
      if (token) seenTokens.add(token);
    });
  } else {
    const snapshot = await admin.firestore().collection('AppDevices')
      .where('active', '==', true)
      .get();
    snapshot.forEach(doc => {
      const token = doc.data().fcmToken as string | undefined;
      if (token) seenTokens.add(token);
    });
  }

  return Array.from(seenTokens);
}

// TODO: reemplazar true por el dominio del backoffice una vez que esté desplegado
// Ejemplo: { cors: ['https://backoffice.tudominio.com'] }
export const sendPushCampaign = onRequest(
  { cors: true },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method Not Allowed' });
      return;
    }

    let campaignId: string | undefined;

    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        console.warn('[sendPushCampaign] Missing or invalid Authorization header');
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const idToken = authHeader.split('Bearer ')[1];
      const decodedToken = await admin.auth().verifyIdToken(idToken);
      console.log('[sendPushCampaign] Token verified, uid:', decodedToken.uid);

      const userDoc = await admin.firestore().collection('SystemUsers').doc(decodedToken.uid).get();
      const role = userDoc.data()?.backofficeRole;
      console.log('[sendPushCampaign] User doc exists:', userDoc.exists, '| role:', role);

      if (!userDoc.exists || role !== 'admin') {
        res.status(403).json({ error: 'Forbidden: Admin required' });
        return;
      }

      const { campaignId: cid, title, body, target, targetLevelIds } = req.body;
      campaignId = cid;
      console.log('[sendPushCampaign] Payload:', { campaignId, title, body, target, targetLevelIds });

      if (!campaignId || !title || !body || !target) {
        res.status(400).json({ error: 'Missing required fields: campaignId, title, body, target' });
        return;
      }

      if (!VALID_TARGETS.has(target as string)) {
        res.status(400).json({ error: `Invalid target. Allowed values: ${[...VALID_TARGETS].join(', ')}` });
        return;
      }

      if (target === 'level_ids') {
        if (!Array.isArray(targetLevelIds) || targetLevelIds.length === 0) {
          res.status(400).json({ error: 'targetLevelIds must be a non-empty array when target is level_ids' });
          return;
        }
      }

      // Mark campaign as in-progress before dispatching so a timeout is distinguishable
      await admin.firestore().collection('PushCampaigns').doc(campaignId).update({
        status: 'sending',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      const tokens = await queryTokens(target as string, (targetLevelIds as string[]) ?? []);
      console.log('[sendPushCampaign] Tokens to send:', tokens.length);

      if (tokens.length === 0) {
        await admin.firestore().collection('PushCampaigns').doc(campaignId).update({
          status: 'failed',
          'stats.total': 0,
          'stats.sent': 0,
          'stats.failed': 0,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        res.status(200).json({ status: 'failed', total: 0, sent: 0, failed: 0 });
        return;
      }

      const baseMessage = {
        notification: { title: title as string, body: body as string },
        android: {
          notification: {
            channelId: 'delivery_aid_notifications',
            priority: 'high' as const,
          },
        },
        data: { campaignId: campaignId as string },
      };

      // Send in batches of 500 (FCM sendEachForMulticast limit)
      let totalSent = 0;
      let totalFailed = 0;
      const staleTokens: string[] = [];

      for (const tokenChunk of chunk(tokens, FCM_CHUNK_SIZE)) {
        const response = await admin.messaging().sendEachForMulticast({
          ...baseMessage,
          tokens: tokenChunk,
        });

        totalSent += response.successCount;
        totalFailed += response.failureCount;

        response.responses.forEach((r, i) => {
          if (!r.success) {
            const code = r.error?.code ?? '';
            console.warn('[sendPushCampaign] Token failed:', code, r.error?.message);
            if (STALE_TOKEN_CODES.has(code)) {
              staleTokens.push(tokenChunk[i]);
            }
          }
        });
      }

      console.log('[sendPushCampaign] FCM result:', { total: tokens.length, sent: totalSent, failed: totalFailed });

      try {
        await cleanStaleTokens(staleTokens);
      } catch (cleanError) {
        // Non-fatal: stale token cleanup failing should not block the campaign status update
        console.error('[sendPushCampaign] Failed to clean stale tokens:', cleanError);
      }

      let status: string;
      if (totalFailed === 0) {
        status = 'sent';
      } else if (totalSent > 0) {
        status = 'partial_failed';
      } else {
        status = 'failed';
      }

      await admin.firestore().collection('PushCampaigns').doc(campaignId).update({
        status,
        sentAt: admin.firestore.FieldValue.serverTimestamp(),
        'stats.total': tokens.length,
        'stats.sent': totalSent,
        'stats.failed': totalFailed,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      res.status(200).json({ status, total: tokens.length, sent: totalSent, failed: totalFailed });

    } catch (error) {
      console.error('[sendPushCampaign] Unhandled error:', error);
      if (campaignId) {
        try {
          await admin.firestore().collection('PushCampaigns').doc(campaignId).update({
            status: 'failed',
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        } catch (updateError) {
          console.error('[sendPushCampaign] Failed to mark campaign as failed:', updateError);
        }
      }
      res.status(500).json({ error: 'Internal Server Error' });
    }
  }
);
