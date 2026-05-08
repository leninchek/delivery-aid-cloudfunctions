import { onRequest } from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';

admin.initializeApp();

const STALE_TOKEN_CODES = new Set([
  'messaging/invalid-registration-token',
  'messaging/registration-token-not-registered',
  'messaging/mismatched-credential',
]);

async function cleanStaleTokens(staleTokens: string[]): Promise<void> {
  if (staleTokens.length === 0) return;

  const snapshot = await admin.firestore().collection('AppDevices')
    .where('fcmToken', 'in', staleTokens)
    .get();

  const batch = admin.firestore().batch();
  snapshot.docs.forEach(doc => {
    batch.update(doc.ref, {
      fcmToken: null,
      active: false,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });
  await batch.commit();
  console.log('[sendPushCampaign] Cleaned stale tokens:', staleTokens.length);
}

export const sendPushCampaign = onRequest({ cors: true }, async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

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

    const { campaignId, title, body, target, targetLevelIds } = req.body;
    console.log('[sendPushCampaign] Payload:', { campaignId, title, body, target, targetLevelIds });

    if (!campaignId || !title || !body || !target) {
      res.status(400).json({ error: 'Missing required fields' });
      return;
    }

    if (target === 'level_ids') {
      if (!Array.isArray(targetLevelIds) || targetLevelIds.length === 0) {
        res.status(400).json({ error: 'targetLevelIds must be a non-empty array when target is level_ids' });
        return;
      }
    }

    let deviceQuery: admin.firestore.Query = admin.firestore().collection('AppDevices')
      .where('active', '==', true);

    if (target === 'level_ids') {
      deviceQuery = deviceQuery.where('orgLevelId', 'in', targetLevelIds);
    }

    const devicesSnapshot = await deviceQuery.get();
    const tokenToDocId = new Map<string, string>();
    devicesSnapshot.forEach(doc => {
      const token = doc.data().fcmToken;
      if (token) tokenToDocId.set(token, doc.id);
    });
    const tokens = Array.from(tokenToDocId.keys());

    console.log('[sendPushCampaign] Devices found:', devicesSnapshot.size, '| Tokens with fcmToken:', tokens.length);

    if (tokens.length === 0) {
      await admin.firestore().collection('PushCampaigns').doc(campaignId).update({
        status: 'failed',
        'stats.total': 0,
        'stats.sent': 0,
        'stats.failed': 0,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      res.status(200).json({ status: 'failed', total: 0, sent: 0, failed: 0 });
      return;
    }

    const message = {
      notification: { title, body },
      android: {
        notification: {
          channelId: 'delivery_aid_notifications',
          priority: 'high' as const,
        },
      },
      data: {
        screen: req.body.screen || '',
        entityId: req.body.entityId || '',
        campaignId,
      },
      tokens,
    };

    const response = await admin.messaging().sendEachForMulticast(message);

    const sent = response.successCount;
    const failed = response.failureCount;
    const total = tokens.length;

    console.log('[sendPushCampaign] FCM result:', { total, sent, failed });

    const staleTokens: string[] = [];
    response.responses.forEach((r, i) => {
      if (!r.success) {
        const code = r.error?.code ?? '';
        console.warn('[sendPushCampaign] Token failed:', code, r.error?.message);
        if (STALE_TOKEN_CODES.has(code)) {
          staleTokens.push(tokens[i]);
        }
      }
    });

    await cleanStaleTokens(staleTokens);

    let status: string;
    if (failed === 0) {
      status = 'sent';
    } else if (sent > 0) {
      status = 'partial_failed';
    } else {
      status = 'failed';
    }

    await admin.firestore().collection('PushCampaigns').doc(campaignId).update({
      status,
      sentAt: admin.firestore.FieldValue.serverTimestamp(),
      'stats.total': total,
      'stats.sent': sent,
      'stats.failed': failed,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.status(200).json({ status, total, sent, failed });

  } catch (error) {
    console.error('[sendPushCampaign] Unhandled error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});
