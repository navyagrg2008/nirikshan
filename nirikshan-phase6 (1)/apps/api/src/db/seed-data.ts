import { Pool } from 'pg';
import { authenticator } from 'otplib';
import * as argon2 from 'argon2';
import { randomBytes, randomUUID } from 'crypto';
import { maskFirm } from '@nirikshan/shared';
import { CryptoService } from '../infra/crypto';

/** All data below is SYNTHETIC placeholder content. Real categories, bands and rule tables replace it before the pilot. */
/** Documents each verification type needs (synthetic defaults; admin can change them). */
const REQUIRED_FOR: Record<string, string> = {
  INVOICE: '{NEW}', INSTRUMENT_PHOTO: '{NEW,RE_VERIFICATION,RENEWAL,RE_TEST}', EXISTING_STICKER: '{RE_VERIFICATION,RENEWAL}',
};

export async function seedReference(pool: Pool): Promise<void> {
  const one = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows[0];
  const area = async (code: string, level: string, name: string, nameHi: string, parent?: string) => {
    const r = await one(`INSERT INTO areas (code, level, name_en, name_hi, parent_id) VALUES ($1,$2::area_level,$3,$4,(SELECT id FROM areas WHERE code=$5))
      ON CONFLICT (code) DO UPDATE SET name_en=EXCLUDED.name_en RETURNING id`, [code, level, name, nameHi, parent ?? null]); return r.id as string;
  };
  await area('DIV-CEN', 'DIVISION', 'Central Division', 'केंद्रीय प्रभाग');
  for (const z of [1, 2]) {
    await area(`ZONE-${z}`, 'ZONE', `Zone ${z}`, `ज़ोन ${z}`, 'DIV-CEN');
    for (const c of [1, 2]) {
      const cc = `CIR-${z}${c}`; await area(cc, 'CIRCLE', `Circle ${z}.${c}`, `सर्कल ${z}.${c}`, `ZONE-${z}`);
      for (const w of [1, 2]) await area(`WARD-${z}${c}${w}`, 'WARD', `Ward ${z}.${c}.${w}`, `वार्ड ${z}.${c}.${w}`, cc);
    }
  }
  // WARD-001 style alias used by the bulk template example
  await area('WARD-001', 'WARD', 'Ward 0 (sample)', 'वार्ड 0 (नमूना)', 'CIR-11');

  for (const [code, en, hi, auto] of [
    ['PLATFORM_SCALE', 'Platform scale', 'प्लेटफ़ॉर्म तराज़ू', false], ['COUNTER_SCALE', 'Counter scale', 'काउंटर तराज़ू', false],
    ['WEIGHBRIDGE', 'Weighbridge', 'वेब्रिज', false], ['FUEL_DISPENSER', 'Fuel dispenser', 'ईंधन डिस्पेंसर', true],
  ] as const) await pool.query('INSERT INTO categories (code, name_en, name_hi, is_automatic) VALUES ($1,$2,$3,$4) ON CONFLICT (code) DO NOTHING', [code, en, hi, auto]);
  for (const [code, name] of [['I', 'Special accuracy (I)'], ['II', 'High accuracy (II)'], ['III', 'Medium accuracy (III)'], ['IIII', 'Ordinary accuracy (IIII)']]) {
    await pool.query('INSERT INTO accuracy_classes (code, name) VALUES ($1,$2) ON CONFLICT (code) DO NOTHING', [code, name]);
  }
  const bandsDone = (await one('SELECT count(*)::int AS n FROM capacity_bands')).n as number;
  const bands: Record<string, [string, string, string][]> = {
    PLATFORM_SCALE: [['0.001', '100', 'kg'], ['100.0001', '1000', 'kg'], ['1000.0001', '5000', 'kg']],
    COUNTER_SCALE: [['0.001', '30', 'kg']], WEIGHBRIDGE: [['1', '30', 't'], ['30.0001', '100', 't']], FUEL_DISPENSER: [['1', '50', 'L']],
  };
  if (!bandsDone) for (const [cat, list] of Object.entries(bands)) for (const [min, max, unit] of list)
    await pool.query('INSERT INTO capacity_bands (category_id, min_capacity, max_capacity, unit) SELECT id,$2,$3,$4 FROM categories WHERE code=$1', [cat, min, max, unit]);
  await pool.query(`INSERT INTO sub_categories (category_id, code, name_en) SELECT id,'ELECTRONIC','Electronic' FROM categories WHERE code IN ('PLATFORM_SCALE','COUNTER_SCALE') ON CONFLICT DO NOTHING`);
  await pool.query(`INSERT INTO sub_categories (category_id, code, name_en) SELECT id,'MECHANICAL','Mechanical' FROM categories WHERE code IN ('PLATFORM_SCALE','COUNTER_SCALE') ON CONFLICT DO NOTHING`);

  for (const [code, en, hi] of [
    ['TRADE_LICENCE', 'Trade licence', 'व्यापार लाइसेंस'], ['GST_CERTIFICATE', 'GST certificate', 'जीएसटी प्रमाणपत्र'], ['ID_PROOF', 'ID proof', 'पहचान पत्र'],
    ['INVOICE', 'Purchase invoice', 'खरीद बिल'], ['INSTRUMENT_PHOTO', 'Instrument photo', 'उपकरण का फोटो'], ['EXISTING_STICKER', 'Existing sticker photo', 'मौजूदा स्टिकर का फोटो'], ['SALE_DOCUMENT', 'Sale document', 'बिक्री दस्तावेज़'],
  ]) await pool.query(`INSERT INTO document_types (code, name_en, name_hi, required_for) VALUES ($1,$2,$3,$4::verification_type[]) ON CONFLICT (code) DO NOTHING`, [code, en, hi, REQUIRED_FOR[code] ?? '{}']);
  // Synthetic holidays (all areas). Real dates come from the department's circular.
  for (const [d, n] of [['2026-01-26', 'Republic Day'], ['2026-08-15', 'Independence Day'], ['2026-10-02', 'Gandhi Jayanti'], ['2026-12-25', 'Christmas Day']] as const)
    await pool.query('INSERT INTO holiday_calendar (area_id, holiday_date, name) SELECT NULL,$1::date,$2 WHERE NOT EXISTS (SELECT 1 FROM holiday_calendar WHERE area_id IS NULL AND holiday_date=$1::date)', [d, n]);
  for (const [code, at, en] of [
    ['DOC_ILLEGIBLE', 'FLAG_DOCUMENT', 'Document is not readable'], ['DOC_EXPIRED', 'FLAG_DOCUMENT', 'Document has expired'], ['OUT_OF_LIMIT', 'REJECT', 'Error is beyond the permissible limit'],
    ['SEAL_BROKEN', 'REJECT', 'Seal is broken or tampered'], ['GEO_MISMATCH', 'GEOFENCE', 'Visit location differs from the registered premises'], ['MISUSE', 'REVOKE', 'Instrument was found tampered'],
  ] as const) await pool.query('INSERT INTO reason_codes (code, applies_to, text_en, public_safe) VALUES ($1,$2,$3,$4) ON CONFLICT (code) DO NOTHING', [code, at, en, at === 'REVOKE']);

  // Rule set v1 (synthetic placeholder values, clearly labelled)
  if (!(await one('SELECT 1 FROM rule_sets LIMIT 1'))) {
    const rs = await one(`INSERT INTO rule_sets (version, status, effective_from, published_at, note) VALUES (1,'PUBLISHED','2026-01-01', now(), 'SYNTHETIC placeholder rules for development only') RETURNING id`);
    await pool.query(`ALTER TABLE mpe_rules DISABLE TRIGGER mpe_rules_immutable`); await pool.query(`ALTER TABLE interval_rules DISABLE TRIGGER interval_rules_immutable`);
    await pool.query(`INSERT INTO mpe_rules (rule_set_id, category_id, capacity_band_id, accuracy_class_id, direction, value, unit)
      SELECT $1, b.category_id, b.id, ac.id, 'PLUS_MINUS', CASE ac.code WHEN 'III' THEN 5 ELSE 10 END, CASE WHEN b.unit='kg' THEN 'g' WHEN b.unit='t' THEN 'kg' ELSE 'mL' END
      FROM capacity_bands b CROSS JOIN accuracy_classes ac WHERE ac.code IN ('III','IIII')`, [rs.id]);
    await pool.query(`INSERT INTO interval_rules (rule_set_id, category_id, capacity_band_id, months, marginal_months, grace_days)
      SELECT $1, category_id, id, 12, 6, 15 FROM capacity_bands`, [rs.id]);
    await pool.query(`ALTER TABLE mpe_rules ENABLE TRIGGER mpe_rules_immutable`); await pool.query(`ALTER TABLE interval_rules ENABLE TRIGGER interval_rules_immutable`);
    for (const [step, h] of [['DOCUMENT_CHECK', 48], ['SCHEDULE', 72], ['DECISION', 72]] as const) await pool.query('INSERT INTO workflow_slas (rule_set_id, step, max_hours) VALUES ($1,$2,$3)', [rs.id, step, h]);
  }

  const T: [string, 'SMS' | 'EMAIL' | 'IN_APP', string, string | null, string][] = [
    ['OTP', 'SMS', 'en', null, 'Your Nirikshan code is {{code}}. It expires in {{minutes}} minutes. Do not share it.'],
    ['OTP', 'SMS', 'hi', null, 'आपका निरीक्षण कोड {{code}} है। यह {{minutes}} मिनट में समाप्त हो जाएगा। इसे किसी को न बताएं।'],
    ['OTP', 'EMAIL', 'en', 'Your Nirikshan code', 'Your Nirikshan code is {{code}}. It expires in {{minutes}} minutes. Do not share it.'],
    ['OTP', 'EMAIL', 'hi', 'आपका निरीक्षण कोड', 'आपका निरीक्षण कोड {{code}} है। यह {{minutes}} मिनट में समाप्त हो जाएगा।'],
    ['ACCOUNT_APPROVED', 'SMS', 'en', null, 'Your Nirikshan account is approved. Sign in to register your instruments.'],
    ['ACCOUNT_APPROVED', 'SMS', 'hi', null, 'आपका निरीक्षण खाता स्वीकृत हो गया है। उपकरण पंजीकृत करने के लिए साइन इन करें।'],
    ['ACCOUNT_APPROVED', 'EMAIL', 'en', 'Your Nirikshan account is approved', 'Your account is approved. Sign in to register your instruments.'],
    ['ACCOUNT_APPROVED', 'EMAIL', 'hi', 'आपका खाता स्वीकृत हो गया है', 'आपका खाता स्वीकृत हो गया है। उपकरण पंजीकृत करने के लिए साइन इन करें।'],
    ['ACCOUNT_APPROVED', 'IN_APP', 'en', 'Account approved', 'You can now register instruments and apply for verification.'],
    ['ACCOUNT_APPROVED', 'IN_APP', 'hi', 'खाता स्वीकृत', 'अब आप उपकरण पंजीकृत कर सकते हैं।'],
    ['ACCOUNT_REJECTED', 'SMS', 'en', null, 'Your Nirikshan account could not be approved. Reason: {{reason}}. You can register again with correct documents.'],
    ['ACCOUNT_REJECTED', 'SMS', 'hi', null, 'आपका निरीक्षण खाता स्वीकृत नहीं हो सका। कारण: {{reason}}।'],
    ['ACCOUNT_REJECTED', 'EMAIL', 'en', 'Your Nirikshan account could not be approved', 'Reason: {{reason}}. You can register again with correct documents.'],
    ['ACCOUNT_REJECTED', 'EMAIL', 'hi', 'आपका खाता स्वीकृत नहीं हो सका', 'कारण: {{reason}}।'],
    ['ACCOUNT_REJECTED', 'IN_APP', 'en', 'Account not approved', 'Reason: {{reason}}'],
    ['ACCOUNT_REJECTED', 'IN_APP', 'hi', 'खाता स्वीकृत नहीं', 'कारण: {{reason}}'],
    ['ACCOUNT_SUBMITTED', 'IN_APP', 'en', 'New account to review', 'A {{type}} account is waiting for document check.'],
    ['STAFF_INVITE', 'EMAIL', 'en', 'You are invited to Nirikshan', 'You have been invited as {{role}}. Set your password and authenticator within 24 hours: {{link}}'],
    ['PASSWORD_CHANGED', 'EMAIL', 'en', 'Your Nirikshan password was changed', 'If this was not you, contact the helpdesk now.'],
    ['PASSWORD_CHANGED', 'IN_APP', 'en', 'Password changed', 'Your password was changed. If this was not you, contact the helpdesk.'],
    ['DUPLICATE_REVIEW_REQUESTED', 'IN_APP', 'en', 'Duplicate instrument to review', 'An owner asked to register an instrument that looks like a duplicate.'],
    ['DUPLICATE_REVIEW_DECIDED', 'EMAIL', 'en', 'Your instrument request was {{outcome}}', 'Your request to register an instrument was {{outcome}}. Sign in for details.'],
    ['DUPLICATE_REVIEW_DECIDED', 'IN_APP', 'en', 'Instrument request {{outcome}}', 'Your duplicate-instrument request was {{outcome}}.'],
  ];
  for (const [ev, ch, lang, subj, body] of T) await pool.query(
    'INSERT INTO notification_templates (event_code, channel, lang, subject, body) VALUES ($1,$2::channel,$3,$4,$5) ON CONFLICT (event_code, channel, lang, version) DO NOTHING', [ev, ch, lang, subj, body]);

  const P3: [string, string[], string, string, string, string][] = [
    // [event, channels, title_en, body_en, title_hi, body_hi] - bodies carry only the application number and a link, never personal details
    ['APPLICATION_RECEIVED', ['SMS', 'IN_APP'], 'Application received', 'Application {{appNo}} received. Track it in Nirikshan.', 'आवेदन प्राप्त', 'आवेदन {{appNo}} प्राप्त हुआ। निरीक्षण में ट्रैक करें।'],
    ['APPLICATION_NEW', ['IN_APP'], 'New application', 'Application {{appNo}} is waiting for document check.', 'नया आवेदन', 'आवेदन {{appNo}} दस्तावेज़ जांच के लिए प्रतीक्षा में है।'],
    ['APPLICATION_CANCELLED', ['SMS', 'IN_APP'], 'Application cancelled', 'Application {{appNo}} was cancelled.', 'आवेदन रद्द', 'आवेदन {{appNo}} रद्द कर दिया गया।'],
    ['DOCUMENT_UPLOADED', ['IN_APP'], 'Document uploaded', 'A document was uploaded on {{appNo}}.', 'दस्तावेज़ अपलोड', '{{appNo}} पर एक दस्तावेज़ अपलोड हुआ।'],
    ['DOCUMENTS_FLAGGED', ['SMS', 'IN_APP'], 'Documents need attention', 'Some documents on {{appNo}} need to be replaced. Open the application.', 'दस्तावेज़ों पर ध्यान दें', '{{appNo}} के कुछ दस्तावेज़ बदलने होंगे। आवेदन खोलें।'],
    ['DOCUMENTS_CHECKED', ['IN_APP'], 'Documents checked', 'Documents on {{appNo}} are accepted.', 'दस्तावेज़ जांचे गए', '{{appNo}} के दस्तावेज़ स्वीकार हुए।'],
    ['VISIT_SCHEDULED', ['SMS', 'IN_APP'], 'Visit scheduled', 'Verification visit for {{appNo}}: {{when}}.', 'दौरा निर्धारित', '{{appNo}} का सत्यापन दौरा: {{when}}।'],
    ['VISIT_ASSIGNED', ['IN_APP'], 'Visit assigned', 'You are assigned {{appNo}}: {{when}}.', 'दौरा सौंपा गया', 'आपको {{appNo}} सौंपा गया: {{when}}।'],
    ['VISIT_RESCHEDULED', ['SMS', 'IN_APP'], 'Visit rescheduled', 'Visit for {{appNo}} moved to {{when}}.', 'दौरा पुनर्निर्धारित', '{{appNo}} का दौरा अब {{when}} को है।'],
    ['VISIT_NOSHOW', ['SMS', 'IN_APP'], 'Visit could not be completed', 'The visit for {{appNo}} could not be completed. A new time will be arranged.', 'दौरा पूरा नहीं हुआ', '{{appNo}} का दौरा पूरा नहीं हो सका। नया समय तय किया जाएगा।'],
    ['RESCHEDULE_REQUESTED', ['IN_APP'], 'Reschedule requested', 'A reschedule was requested on {{appNo}}.', 'पुनर्निर्धारण अनुरोध', '{{appNo}} पर पुनर्निर्धारण का अनुरोध आया।'],
    ['RESCHEDULE_DECIDED', ['SMS', 'IN_APP'], 'Reschedule {{outcome}}', 'Your reschedule request on {{appNo}} was {{outcome}}.', 'पुनर्निर्धारण {{outcome}}', '{{appNo}} पर आपके अनुरोध का परिणाम: {{outcome}}।'],
    ['SCHEDULE_REVIEW_NEEDED', ['IN_APP'], 'Schedule needs review', '{{appNo}} needs an officer to confirm the visit.', 'समय-सारणी की समीक्षा', '{{appNo}} के दौरे की पुष्टि अधिकारी को करनी है।'],
    ['ATTEMPTS_EXHAUSTED', ['IN_APP'], 'Visit attempts used up', '{{appNo}} has reached the attempt limit and needs a decision.', 'प्रयास सीमा पूर्ण', '{{appNo}} प्रयास सीमा तक पहुंच गया; निर्णय चाहिए।'],
  ];
  for (const [ev, chs, te, be, th, bh] of P3) for (const ch of chs) for (const [lang, t, b] of [['en', te, be], ['hi', th, bh]] as const)
    await pool.query('INSERT INTO notification_templates (event_code, channel, lang, subject, body) VALUES ($1,$2::channel,$3,$4,$5) ON CONFLICT (event_code, channel, lang, version) DO NOTHING', [ev, ch, lang, t, b]);

  const P4: [string, string[], string, string, string, string][] = [
    ['INSPECTION_SUBMITTED', ['IN_APP'], 'Inspection submitted', 'The inspection for {{appNo}} is submitted and waiting for your decision.', 'निरीक्षण जमा हुआ', '{{appNo}} का निरीक्षण जमा हो गया है और आपके निर्णय की प्रतीक्षा में है।'],
    ['INSPECTION_DONE', ['SMS', 'IN_APP'], 'Inspection completed', 'The inspection for {{appNo}} is completed. The officer will decide shortly.', 'निरीक्षण पूरा हुआ', '{{appNo}} का निरीक्षण पूरा हुआ। अधिकारी शीघ्र निर्णय लेंगे।'],
    ['DECISION_REFERRED', ['IN_APP'], 'Case referred to you', '{{appNo}} was referred for your decision.', 'मामला आपको भेजा गया', '{{appNo}} आपके निर्णय के लिए भेजा गया है।'],
    ['SECOND_APPROVAL_NEEDED', ['IN_APP'], 'Second approval needed', '{{appNo}} needs a second approver.', 'दूसरी स्वीकृति आवश्यक', '{{appNo}} को दूसरे स्वीकृतिकर्ता की आवश्यकता है।'],
    ['REINSPECTION_NEEDED', ['SMS', 'IN_APP'], 'Re-inspection needed', '{{appNo}} needs another inspection. A new time will be arranged.', 'पुनः निरीक्षण आवश्यक', '{{appNo}} का फिर से निरीक्षण होगा। नया समय बताया जाएगा।'],
    ['APPLICATION_REJECTED', ['SMS', 'EMAIL', 'IN_APP'], 'Verification not approved', '{{appNo}} was not approved. Reason: {{reason}}. You may apply again after correction.', 'सत्यापन स्वीकृत नहीं', '{{appNo}} स्वीकृत नहीं हुआ। कारण: {{reason}}। सुधार के बाद फिर आवेदन कर सकते हैं।'],
    ['CERTIFICATE_ISSUED', ['SMS', 'EMAIL', 'IN_APP'], 'Certificate issued', 'Certificate {{certNo}} is issued for {{appNo}}. Valid till {{validTill}}.', 'प्रमाणपत्र जारी', '{{appNo}} के लिए प्रमाणपत्र {{certNo}} जारी हुआ। वैधता: {{validTill}}।'],
    ['CERTIFICATE_SUSPENDED', ['SMS', 'EMAIL', 'IN_APP'], 'Certificate suspended', 'Certificate {{certNo}} is suspended. Reason: {{reason}}.', 'प्रमाणपत्र निलंबित', 'प्रमाणपत्र {{certNo}} निलंबित है। कारण: {{reason}}।'],
    ['CERTIFICATE_REVOKED', ['SMS', 'EMAIL', 'IN_APP'], 'Certificate revoked', 'Certificate {{certNo}} is revoked. Reason: {{reason}}.', 'प्रमाणपत्र रद्द', 'प्रमाणपत्र {{certNo}} रद्द किया गया। कारण: {{reason}}।'],
    ['CERTIFICATE_REINSTATED', ['SMS', 'EMAIL', 'IN_APP'], 'Certificate reinstated', 'Certificate {{certNo}} is valid again.', 'प्रमाणपत्र बहाल', 'प्रमाणपत्र {{certNo}} फिर से वैध है।'],
    ['CERTIFICATE_REISSUED', ['SMS', 'EMAIL', 'IN_APP'], 'Certificate re-issued', 'Certificate {{certNo}} replaces {{oldNo}}.', 'प्रमाणपत्र पुनः जारी', 'प्रमाणपत्र {{certNo}} ने {{oldNo}} का स्थान लिया।'],
  ];
  for (const [ev, chs, te, be, th, bh] of P4) for (const ch of chs) for (const [lang, t, b] of [['en', te, be], ['hi', th, bh]] as const)
    await pool.query('INSERT INTO notification_templates (event_code, channel, lang, subject, body) VALUES ($1,$2::channel,$3,$4,$5) ON CONFLICT (event_code, channel, lang, version) DO NOTHING', [ev, ch, lang, t, b]);
  const P5: [string, string[], string, string, string, string][] = [
    ['RENEWAL_REMINDER', ['SMS', 'EMAIL', 'IN_APP'], 'Renewal due in {{days}} days', 'Certificate {{certNo}} expires on {{validTill}} ({{days}} days). Apply for renewal in the Nirikshan portal.', 'नवीनीकरण {{days}} दिन में', 'प्रमाणपत्र {{certNo}} {{validTill}} को समाप्त होगा ({{days}} दिन)। Nirikshan पोर्टल पर नवीनीकरण के लिए आवेदन करें।'],
    ['CERTIFICATE_EXPIRED', ['EMAIL', 'IN_APP'], 'Certificate expired', 'Certificate {{certNo}} expired on {{validTill}}. Apply for verification to use the instrument legally.', 'प्रमाणपत्र समाप्त', 'प्रमाणपत्र {{certNo}} {{validTill}} को समाप्त हो गया। उपकरण के वैध उपयोग के लिए सत्यापन हेतु आवेदन करें।'],
    ['APPLICATION_EXPIRED', ['SMS', 'IN_APP'], 'Application closed', 'Application {{appNo}} was closed because the documents were not completed in time. You may apply again.', 'आवेदन बंद', 'आवेदन {{appNo}} समय पर दस्तावेज़ पूरे न होने से बंद हो गया। आप फिर से आवेदन कर सकते हैं।'],
    ['VISIT_REMINDER', ['SMS', 'IN_APP'], 'Visit tomorrow', 'Reminder: visit for {{appNo}} on {{when}}.', 'दौरे की याद', 'याद दिलाना: {{appNo}} का दौरा {{when}} को है।'],
    ['SLA_BREACH', ['IN_APP'], 'Deadline missed', '{{appNo}} has passed its deadline for: {{step}}.', 'समय-सीमा पार', '{{appNo}} की समय-सीमा पार हो गई: {{step}}।'],
    ['SLA_DIGEST', ['IN_APP'], 'Daily summary', '{{overdue}} cases are past their deadline and {{atRisk}} are close to it.', 'दैनिक सारांश', '{{overdue}} मामले समय-सीमा पार कर चुके हैं और {{atRisk}} के करीब हैं।'],
    ['AUDIT_CHAIN_BROKEN', ['IN_APP'], 'Audit trail check failed', 'The nightly audit check found a break near record {{id}}. Investigate now.', 'ऑडिट जाँच विफल', 'रात की ऑडिट जाँच में रिकॉर्ड {{id}} के पास गड़बड़ मिली। तुरंत जाँचें।'],
    ['JOB_FAILED', ['IN_APP'], 'Background job failed', 'Job {{job}} failed: {{error}}', 'बैकग्राउंड कार्य विफल', 'कार्य {{job}} विफल: {{error}}'],
    ['REQUEST_NEW', ['IN_APP'], 'New request', 'A {{kind}} request is waiting for {{instrumentNo}}.', 'नया अनुरोध', '{{instrumentNo}} के लिए {{kind}} अनुरोध प्रतीक्षा में है।'],
    ['REQUEST_DECIDED', ['SMS', 'IN_APP'], 'Request {{outcome}}', 'Your {{kind}} request for {{instrumentNo}} was {{outcome}}.', 'अनुरोध {{outcome}}', '{{instrumentNo}} के आपके {{kind}} अनुरोध का परिणाम: {{outcome}}।'],
    ['TRANSFER_INCOMING', ['SMS', 'IN_APP'], 'Instrument transfer', 'Instrument {{instrumentNo}} is being transferred to your business. An officer will confirm it.', 'उपकरण हस्तांतरण', 'उपकरण {{instrumentNo}} आपके व्यवसाय को हस्तांतरित किया जा रहा है। अधिकारी इसकी पुष्टि करेंगे।'],
    ['ENFORCEMENT_NOTICE', ['SMS', 'EMAIL', 'IN_APP'], 'Verification overdue', 'Notice {{noticeNo}}: verification of instrument {{instrumentNo}} is overdue since {{validTill}}. Apply for verification now.', 'सत्यापन बकाया', 'नोटिस {{noticeNo}}: उपकरण {{instrumentNo}} का सत्यापन {{validTill}} से बकाया है। अभी आवेदन करें।'],
    ['TAMPER_REPORT_RECEIVED', ['IN_APP'], 'Tamper report received', 'A tamper report {{ref}} was received for your area.', 'छेड़छाड़ की शिकायत', 'आपके क्षेत्र के लिए छेड़छाड़ की शिकायत {{ref}} मिली।'],
    ['GRIEVANCE_RECEIVED', ['IN_APP'], 'New grievance', 'Grievance {{ref}} was raised. Reply due by {{due}}.', 'नई शिकायत', 'शिकायत {{ref}} दर्ज हुई। उत्तर की अंतिम तिथि {{due}}।'],
    ['GRIEVANCE_UPDATED', ['SMS', 'IN_APP'], 'Grievance update', 'Your grievance {{ref}} is now {{status}}.', 'शिकायत की स्थिति', 'आपकी शिकायत {{ref}} अब {{status}} है।'],
    ['DSR_RECEIVED', ['IN_APP'], 'Data request received', 'A {{kind}} data request was received. Due by {{due}}.', 'डेटा अनुरोध मिला', '{{kind}} डेटा अनुरोध मिला। अंतिम तिथि {{due}}।'],
    ['DSR_UPDATED', ['EMAIL', 'IN_APP'], 'Your data request', 'Your {{kind}} request is now {{status}}.', 'आपका डेटा अनुरोध', 'आपका {{kind}} अनुरोध अब {{status}} है।'],
    ['RULESET_REVIEW_REQUESTED', ['IN_APP'], 'Rule set needs review', 'Rule set version {{version}} is waiting for a second admin to review.', 'नियम-समूह की समीक्षा', 'नियम-समूह संस्करण {{version}} दूसरे एडमिन की समीक्षा के लिए प्रतीक्षा में है।'],
    ['RULESET_PUBLISHED', ['IN_APP'], 'Rule set published', 'Rule set version {{version}} is published from {{from}}.', 'नियम-समूह प्रकाशित', 'नियम-समूह संस्करण {{version}} {{from}} से प्रकाशित है।'],
  ];
  for (const [ev, chs, te, be, th, bh] of P5) for (const ch of chs) for (const [lang, t, b] of [['en', te, be], ['hi', th, bh]] as const)
    await pool.query('INSERT INTO notification_templates (event_code, channel, lang, subject, body) VALUES ($1,$2::channel,$3,$4,$5) ON CONFLICT (event_code, channel, lang, version) DO NOTHING', [ev, ch, lang, t, b]);
  for (const [code, at, en, pub] of [
    ['IDENTITY_MISMATCH', 'REJECT', 'Instrument does not match the registered details', false], ['MAGNETIC_INTERFERENCE', 'REJECT', 'Interference device found', false],
    ['REPAIR_NEEDED', 'REJECT', 'Instrument needs repair before verification', false],
    ['UNDER_REVIEW', 'SUSPEND', 'Certificate is under review', true], ['COMPLAINT_PENDING', 'SUSPEND', 'A complaint is being examined', true],
    ['ISSUED_IN_ERROR', 'REVOKE', 'Issued in error', true],
  ] as const) await pool.query('INSERT INTO reason_codes (code, applies_to, text_en, public_safe) VALUES ($1,$2,$3,$4) ON CONFLICT (code) DO NOTHING', [code, at, en, pub]);

  // Checklist templates (synthetic wording; the department supplies the real list). One published version per category.
  const common = [
    { code: 'IDENTITY', textEn: 'Make, model and serial number match the registered instrument', textHi: 'मेक, मॉडल और क्रमांक पंजीकृत उपकरण से मेल खाते हैं', critical: true, required: true, pass: 'YES' },
    { code: 'SEALS', textEn: 'Seals and stamping marks are intact', textHi: 'सील और मुहर के निशान सुरक्षित हैं', critical: true, required: true, pass: 'YES' },
    { code: 'TAMPER', textEn: 'Signs of tampering or unauthorised change found', textHi: 'छेड़छाड़ या अनधिकृत बदलाव के संकेत मिले', critical: true, required: true, pass: 'NO' },
    { code: 'MAGNETIC', textEn: 'Magnet or electronic interference device found', textHi: 'चुंबक या इलेक्ट्रॉनिक हस्तक्षेप उपकरण मिला', critical: true, required: true, pass: 'NO' },
    { code: 'DISPLAY', textEn: 'Display is clear and its resolution matches the registered value', textHi: 'डिस्प्ले साफ़ है और रिज़ॉल्यूशन पंजीकृत मान जैसा है', critical: false, required: true, pass: 'YES' },
  ];
  const extra: Record<string, object[]> = {
    FUEL_DISPENSER: [{ code: 'LEAK', textEn: 'Nozzle, hose and meter show no leak', textHi: 'नोज़ल, पाइप और मीटर में रिसाव नहीं है', critical: false, required: true, pass: 'YES' },
      { code: 'ZERO', textEn: 'Meter returns to zero before each delivery', textHi: 'हर डिलीवरी से पहले मीटर शून्य पर लौटता है', critical: false, required: true, pass: 'YES' }],
  };
  const scale = [{ code: 'ZERO', textEn: 'Zero and span settings are correct', textHi: 'ज़ीरो और स्पैन सेटिंग सही हैं', critical: false, required: true, pass: 'YES' },
    { code: 'ANCILLARY', textEn: 'Ancillary devices (printer, remote display, load cells) work properly', textHi: 'सहायक उपकरण (प्रिंटर, रिमोट डिस्प्ले, लोड सेल) ठीक काम करते हैं', critical: false, required: false, pass: 'YES' }];
  for (const c of (await pool.query('SELECT id, code FROM categories')).rows as { id: string; code: string }[]) {
    await pool.query(`INSERT INTO checklist_templates (category_id, version, items, status, effective_from) VALUES ($1,1,$2,'PUBLISHED','2026-01-01') ON CONFLICT (category_id, version) DO NOTHING`,
      [c.id, JSON.stringify([...common, ...(extra[c.code] ?? scale)])]);
  }

  if (!(await one('SELECT 1 FROM notices LIMIT 1'))) {
    for (const [t, th, tag] of [['Sample circular: verification schedule for the year (synthetic)', 'नमूना परिपत्र: वर्ष का सत्यापन कार्यक्रम (कृत्रिम)', 'CIRCULAR'], ['Sample notice: holiday list (synthetic)', 'नमूना सूचना: अवकाश सूची (कृत्रिम)', 'HOLIDAY'], ['Sample gazette notice: revised limits (synthetic)', 'नमूना राजपत्र: संशोधित सीमाएं (कृत्रिम)', 'GAZETTE']])
      await pool.query(`INSERT INTO notices (title_en, title_hi, tag, published_at) VALUES ($1,$2,$3, now())`, [t, th, tag]);
  }
}

export interface DemoCreds { role: string; mobile: string; email: string; password: string; totpSecret?: string }

/** Demo users, one per role. Passwords are random and returned once; MFA secrets are seeded for development only. */
export async function seedDemoUsers(pool: Pool, crypto: CryptoService, argonMemory = 19456): Promise<DemoCreds[]> {
  const out: DemoCreds[] = []; const wards = (await pool.query(`SELECT id, code FROM areas WHERE level='WARD' ORDER BY code LIMIT 2`)).rows;
  const specs: { role: string; first: string; mobile: string; kind?: string; area?: boolean }[] = [
    { role: 'OWNER', first: 'Demo Owner', mobile: '9000000001' }, { role: 'TRADER', first: 'Demo Trader', mobile: '9000000002', kind: 'DEALER' },
    { role: 'OFFICER', first: 'Demo Officer', mobile: '9000000003', area: true }, { role: 'INSPECTOR', first: 'Demo Inspector', mobile: '9000000004', area: true },
    { role: 'ADMIN', first: 'Demo Admin', mobile: '9000000005' },
    { role: 'INSPECTOR', first: 'Demo Inspector Two', mobile: '9000000006', area: true },
    { role: 'SENIOR_OFFICER', first: 'Demo Senior Officer', mobile: '9000000007', area: true },
    { role: 'OFFICER', first: 'Demo Officer Two', mobile: '9000000008', area: true },
    { role: 'ADMIN', first: 'Demo Admin Two', mobile: '9000000009' },   // a second admin so rule sets can be reviewed by someone other than the author
  ];
  for (const s of specs) {
    const email = `${s.role.toLowerCase()}${s.first.endsWith('Two') ? '2' : ''}@demo.nirikshan.example`;
    if ((await pool.query('SELECT 1 FROM users WHERE mobile_bidx = $1', [crypto.blindIndex('mobile', s.mobile)])).rowCount) continue;
    const password = randomBytes(9).toString('base64url') + 'aA1!'; const id = randomUUID(); const staff = ['OFFICER', 'SENIOR_OFFICER', 'INSPECTOR', 'ADMIN'].includes(s.role);
    const totp = staff ? authenticator.generateSecret(20) : undefined;
    await pool.query(
      `INSERT INTO users (id, keycloak_sub, account_status, mobile_enc, mobile_bidx, email_enc, email_bidx, mobile_verified_at, display_name_masked, mfa_enrolled) VALUES ($1,$2,'ACTIVE',$3,$4,$5,$6,now(),$7,$8)`,
      [id, `local:${id}`, crypto.encrypt(s.mobile), crypto.blindIndex('mobile', s.mobile), crypto.encrypt(email), crypto.blindIndex('email', email), maskFirm(s.first), staff]);
    await pool.query('INSERT INTO local_credentials (user_id, password_hash, totp_secret_enc, totp_confirmed_at) VALUES ($1,$2,$3,$4)',
      [id, await argon2.hash(password, { type: argon2.argon2id, memoryCost: argonMemory, timeCost: 2, parallelism: 1 }), totp ? crypto.encrypt(totp) : null, totp ? new Date() : null]);
    await pool.query('INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code=$2', [id, s.role]);
    await pool.query('INSERT INTO user_profiles (user_id, full_name_enc) VALUES ($1,$2)', [id, crypto.encrypt(s.first)]);
    if (s.role === 'OWNER' || s.role === 'TRADER') {
      await pool.query(`INSERT INTO businesses (owner_user_id, type, firm_name_enc, firm_name_masked, area_id) VALUES ($1,$2::business_type,$3,$4,$5)`,
        [id, s.kind ?? 'OWNER', crypto.encrypt(`${s.first} Stores`), maskFirm(`${s.first} Stores`), wards[0].id]);
    }
    if (s.area) await pool.query(`INSERT INTO user_area_scopes (user_id, area_id) SELECT $1, id FROM areas WHERE code='DIV-CEN'`, [id]);
    out.push({ role: s.role, mobile: s.mobile, email, password, totpSecret: totp });
  }
  // Inspectors need a profile and category skills before the scheduling engine will consider them.
  for (const m of ['9000000004', '9000000006']) {
    const u = (await pool.query('SELECT id FROM users WHERE mobile_bidx = $1', [crypto.blindIndex('mobile', m)])).rows[0] as { id: string } | undefined; if (!u) continue;
    await pool.query('INSERT INTO inspector_profiles (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [u.id]);
    await pool.query('INSERT INTO inspector_skills (inspector_id, category_id) SELECT $1, id FROM categories ON CONFLICT DO NOTHING', [u.id]);
  }
  return out;
}
