import { all, one } from "./db.ts";
import { embed, vectorSearch } from "./embed.ts";

/**
 * Local school policies commonly held by Victorian government schools, each tied to the PAL
 * topic that sets the expectation. The Department's definitive list (with templates) is on the
 * School Policy Templates Portal, which needs a staff login — schools can mark items "not needed".
 */
export interface ChecklistItem {
  key: string;
  name: string;
  pal: string;
  about: string;
  match: RegExp;
}

export const CHECKLIST: ChecklistItem[] = [
  { key: "child-safety-wellbeing", name: "Child Safety and Wellbeing Policy", pal: "child-safe-standards", about: "How the school meets the Child Safe Standards and keeps students safe from abuse.", match: /child safe(ty)?( and wellbeing)? polic|child safe standards polic/i },
  { key: "child-safety-code", name: "Child Safety Code of Conduct", pal: "child-safe-standards", about: "Expected and prohibited behaviour for all adults working with students.", match: /child safe(ty)?.*code of conduct|code of conduct.*(staff|adults|child safe)/i },
  { key: "child-safety-reporting", name: "Child Safety Responding and Reporting Obligations", pal: "child-abuse-including-grooming-identification-response", about: "How staff identify, respond to and report suspected child abuse.", match: /respond(ing)? and report|reporting obligations|mandatory report/i },
  { key: "risk-register", name: "Child Safety Risk Register", pal: "child-safe-standards", about: "Identified child safety risks and the controls in place.", match: /risk register/i },
  { key: "wellbeing-engagement", name: "Student Wellbeing and Engagement Policy", pal: "student-engagement", about: "Expectations, supports and consequences for student behaviour and engagement.", match: /wellbeing and engagement|engagement polic/i },
  { key: "statement-of-values", name: "Statement of Values and School Philosophy", pal: "values-department-values-schools", about: "The school's values and expectations of the school community.", match: /statement of values|school philosophy/i },
  { key: "bullying", name: "Bullying Prevention Policy", pal: "bullying-prevention-response", about: "How the school prevents and responds to bullying.", match: /bully/i },
  { key: "complaints", name: "Complaints Policy", pal: "complaint-resolution", about: "How parents and the community raise and resolve concerns.", match: /complaint/i },
  { key: "inclusion", name: "Inclusion and Diversity Policy", pal: "equal-opportunity-human-rights-students", about: "Supporting students of all backgrounds, abilities and identities.", match: /inclusion|diversity/i },
  { key: "duty-of-care", name: "Duty of Care Policy", pal: "duty-of-care", about: "Staff responsibilities to take reasonable steps to keep students safe.", match: /duty of care/i },
  { key: "supervision", name: "Yard Duty and Supervision Policy", pal: "supervision-students", about: "How students are supervised before, during and after school.", match: /yard duty|supervision/i },
  { key: "first-aid", name: "First Aid Policy", pal: "first-aid-students-and-staff", about: "First aid training, kits and response for students and staff.", match: /first aid/i },
  { key: "medication", name: "Administration of Medication Policy", pal: "medication", about: "How medication is stored, given and recorded.", match: /medication/i },
  { key: "anaphylaxis", name: "Anaphylaxis Policy", pal: "anaphylaxis", about: "Managing students at risk of anaphylaxis, including Ministerial Order 706.", match: /anaphyla/i },
  { key: "asthma", name: "Asthma Policy", pal: "asthma", about: "Supporting students with asthma and responding to attacks.", match: /asthma/i },
  { key: "health-care-needs", name: "Health Care Needs Policy", pal: "health-care-needs", about: "Planning for students with ongoing or complex health needs.", match: /health care needs|healthcare needs/i },
  { key: "mobile-phones", name: "Mobile Phones – Student Use Policy", pal: "mobile-phones-personal-electronic-devices-student-use", about: "Students' use of phones and personal devices at school.", match: /mobile phone|personal (electronic )?devices/i },
  { key: "digital-learning", name: "Digital Learning Policy", pal: "digital-learning", about: "Safe and responsible use of the internet, social media and digital devices.", match: /digital (learning|technolog)|internet|acceptable use|cyber ?safe|social media/i },
  { key: "visitors", name: "Visitors Policy", pal: "visitors", about: "Managing visitors to the school site.", match: /visitor/i },
  { key: "volunteers", name: "Volunteers Policy", pal: "volunteers", about: "Recruiting, screening and supporting volunteers.", match: /volunteer/i },
  { key: "excursions", name: "Camps and Excursions Policy", pal: "excursions", about: "Planning, approving and running excursions and camps.", match: /excursion|camps?\b/i },
  { key: "parent-payments", name: "Parent Payments Policy", pal: "parent-contributions", about: "Essential items, optional extras and voluntary contributions.", match: /parent payment|parent contribution/i },
  { key: "attendance", name: "Attendance Policy", pal: "attendance", about: "Recording and following up student attendance.", match: /attendance/i },
  { key: "enrolment", name: "Enrolment Policy", pal: "enrolment", about: "How the school manages enrolments and placement.", match: /enrol/i },
  { key: "privacy", name: "Privacy and Information Sharing", pal: "privacy-information-sharing", about: "How the school collects, uses and shares personal information.", match: /privacy|information sharing|collection notice/i },
  { key: "emergency", name: "Emergency Management Plan", pal: "emergency-critical-incident-management-planning", about: "Responding to emergencies and critical incidents.", match: /emergency|critical incident/i },
  { key: "dress-code", name: "Student Dress Code", pal: "student-dress-code", about: "Uniform and dress expectations.", match: /dress code|uniform/i },
  { key: "sun-protection", name: "Sun Protection Policy", pal: "sun-protection", about: "Protecting students and staff from UV exposure.", match: /sun ?(smart|protection)|uv protection/i },
  { key: "reporting", name: "Assessment and Reporting", pal: "reporting-student-achievement", about: "How student learning is assessed and reported to families.", match: /assessment (and|&) reporting|reporting (student|to parents|achievement)|assessment polic/i },
  { key: "gen-ai", name: "Generative AI Use", pal: "generative-artificial-intelligence", about: "How staff and students may use generative AI tools.", match: /artificial intelligence|generative ai|\bai\b/i },
];

export interface ChecklistRow {
  key: string;
  name: string;
  about: string;
  pal: { slug: string; title: string | null; documentId: number | null; updated: string | null };
  status: "linked" | "found" | "possible" | "missing" | "not_applicable";
  document: { id: number; title: string; reviewed: string | null; nextReview: string | null } | null;
  flags: string[];
}

let itemVectors: Float32Array[] | null = null;

export async function buildChecklist(schoolId: number): Promise<ChecklistRow[]> {
  const docs = all<{ id: number; title: string; reviewed_date: string | null; next_review: string | null; needs_ai: number }>(
    "SELECT id, title, reviewed_date, next_review, needs_ai FROM documents WHERE school_id = ? AND status = 'ready'",
    schoolId
  );
  const marks = new Map(
    all<{ item_key: string; document_id: number | null; status: string }>("SELECT * FROM checklist_marks WHERE school_id = ?", schoolId).map((m) => [m.item_key, m])
  );
  itemVectors ??= await embed(CHECKLIST.map((i) => `${i.name}. ${i.about}`));
  const today = new Date().toISOString().slice(0, 10);
  const docById = new Map(docs.map((d) => [d.id, d]));

  return CHECKLIST.map((item, i) => {
    const palDoc = one<{ id: number; title: string; reviewed_date: string | null }>(
      "SELECT id, title, reviewed_date FROM documents WHERE pal_slug = ? AND status = 'ready'", item.pal
    );
    const lastPalChange = one<{ d: string }>("SELECT MAX(changed_on) AS d FROM pal_changes WHERE slug = ?", item.pal)?.d ?? null;
    const pal = { slug: item.pal, title: palDoc?.title ?? null, documentId: palDoc?.id ?? null, updated: lastPalChange ?? palDoc?.reviewed_date ?? null };

    const mark = marks.get(item.key);
    let status: ChecklistRow["status"] = "missing";
    let doc: (typeof docs)[number] | undefined;

    if (mark?.status === "not_applicable") status = "not_applicable";
    else if (mark?.status === "linked" && mark.document_id && docById.has(mark.document_id)) {
      status = "linked";
      doc = docById.get(mark.document_id);
    } else {
      doc = docs.find((d) => item.match.test(d.title));
      if (doc) status = "found";
      else if (docs.length) {
        const hits = vectorSearch(itemVectors![i], (e) => e.schoolId === schoolId, 12);
        const best = hits[0];
        if (best && best.score >= 0.5 && docById.has(best.docId)) {
          status = "possible";
          doc = docById.get(best.docId);
        }
      }
    }

    const flags: string[] = [];
    if (doc && status !== "possible") {
      if (doc.next_review && doc.next_review.slice(0, 10) < today) flags.push(`Review was due ${doc.next_review}`);
      else if (!doc.next_review && doc.reviewed_date && yearsAgo(doc.reviewed_date) >= 3) flags.push(`Last reviewed ${doc.reviewed_date}`);
      if (pal.updated && doc.reviewed_date && pal.updated > doc.reviewed_date) flags.push(`PAL updated ${pal.updated}, after your last review`);
      // Review dates are read by the AI, so only flag their absence once it has read the document.
      if (!doc.reviewed_date && !doc.next_review && !doc.needs_ai) flags.push("No review date found in the document");
    }

    return {
      key: item.key,
      name: item.name,
      about: item.about,
      pal,
      status,
      document: doc ? { id: doc.id, title: doc.title, reviewed: doc.reviewed_date, nextReview: doc.next_review } : null,
      flags,
    };
  });
}

function yearsAgo(date: string): number {
  const t = Date.parse(date.length === 7 ? `${date}-01` : date);
  return Number.isNaN(t) ? 0 : (Date.now() - t) / (365.25 * 86_400_000);
}
