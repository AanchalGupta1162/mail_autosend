import ExcelJS from "exceljs";

const SAMPLE_ROWS = [
  {
    company: "Acme Robotics",
    role: "Software Engineer Intern",
    person: "Priya Nair",
    email: "harshavardhan.khamkar@gmail.com",
    subject: "Software Engineer Intern role at Acme Robotics",
    mailText:
      "Hi Priya,\n\n" +
      "I came across the **Software Engineer Intern** opening at Acme Robotics and wanted to reach out directly. " +
      "I've been building backend systems in Node.js and Python, most recently a small automation tool that queues and sends personalized emails from a spreadsheet, and I'd love to bring that same practical approach to your team.\n\n" +
      "Would you be open to a quick chat about the role? I've attached my resume for context.\n\n" +
      "Best,\nHarshavardhan Khamkar",
    followUpText:
      "Hi Priya,\n\n" +
      "Just following up on my note below about the **Software Engineer Intern** role — would love to hear your thoughts whenever you get a chance.\n\n" +
      "Best,\nHarshavardhan Khamkar",
  },
  {
    company: "Northwind Analytics",
    role: "Data Engineer",
    person: "Daniel Ortiz",
    email: "harshavardhan.khamkar@gmail.com",
    subject: "Interested in the Data Engineer role at Northwind Analytics",
    mailText:
      "Hi Daniel,\n\n" +
      "I saw the **Data Engineer** opening at Northwind Analytics and it lines up well with what I enjoy working on — building reliable pipelines and tooling around data. " +
      "I've worked with Python, SQL, and workflow scheduling, and I'm comfortable owning a problem end to end.\n\n" +
      "I'd welcome the chance to talk about how I could contribute to your data team.\n\n" +
      "Best,\nHarshavardhan Khamkar",
    followUpText:
      "Hi Daniel,\n\n" +
      "Wanted to bump this back to the top of your inbox — still very interested in the **Data Engineer** role if it's still open.\n\n" +
      "Best,\nHarshavardhan Khamkar",
  },
  {
    company: "Bluepeak Health",
    role: "Backend Developer",
    person: "Meera Shah",
    email: "harshavardhan.khamkar@gmail.com",
    subject: "Backend Developer role at Bluepeak Health",
    mailText:
      "Hi Meera,\n\n" +
      "I'm reaching out about the **Backend Developer** position at Bluepeak Health. " +
      "Building software that touches healthcare appeals to me because of the direct impact on people's lives, and I'd bring solid experience in API design and database-backed services to the role.\n\n" +
      "Happy to share more details or jump on a short call whenever convenient.\n\n" +
      "Best,\nHarshavardhan Khamkar",
    followUpText:
      "Hi Meera,\n\n" +
      "Following up on the **Backend Developer** role below — happy to answer any questions or jump on a quick call.\n\n" +
      "Best,\nHarshavardhan Khamkar",
  },
  {
    company: "Vertex Cloud",
    role: "DevOps Engineer",
    person: "Tom Richardson",
    email: "harshavardhan.khamkar@gmail.com",
    subject: "DevOps Engineer opening at Vertex Cloud",
    mailText:
      "Hi Tom,\n\n" +
      "I noticed Vertex Cloud is hiring a **DevOps Engineer**. I enjoy working close to infrastructure — CI/CD pipelines, containerization, and automating the repetitive parts of shipping software — and this role looks like a strong fit for that interest.\n\n" +
      "Let me know if you'd be open to discussing it further.\n\n" +
      "Best,\nHarshavardhan Khamkar",
    followUpText:
      "Hi Tom,\n\n" +
      "Just circling back on the **DevOps Engineer** role — let me know if it'd help to talk this week.\n\n" +
      "Best,\nHarshavardhan Khamkar",
  },
  {
    company: "Lumen Studios",
    role: "Full Stack Developer",
    person: "Aisha Khan",
    email: "harshavardhan.khamkar@gmail.com",
    subject: "Full Stack Developer role at Lumen Studios",
    mailText:
      "Hi Aisha,\n\n" +
      "I'd love to be considered for the **Full Stack Developer** role at Lumen Studios. " +
      "I've worked across both frontend and backend — React on one side, Node/Python services on the other — and enjoy owning features from the UI down to the database.\n\n" +
      "Would you have a few minutes to talk this week?\n\n" +
      "Best,\nHarshavardhan Khamkar",
    followUpText:
      "Hi Aisha,\n\n" +
      "Following up on the **Full Stack Developer** role — still very interested, let me know if there's a good time to connect.\n\n" +
      "Best,\nHarshavardhan Khamkar",
  },
];

async function main() {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Recruiters");

  worksheet.columns = [
    { header: "Company", key: "company", width: 20 },
    { header: "Role", key: "role", width: 24 },
    { header: "Person", key: "person", width: 18 },
    { header: "Email", key: "email", width: 30 },
    { header: "Subject", key: "subject", width: 36 },
    { header: "Mail Text", key: "mailText", width: 60 },
    { header: "Follow-up Text", key: "followUpText", width: 60 },
    { header: "Status", key: "status", width: 10 },
    { header: "Message ID", key: "messageId", width: 30 },
    { header: "Last Sent At", key: "lastSentAt", width: 22 },
    { header: "Follow-up Count", key: "followUpCount", width: 16 },
    { header: "Error", key: "error", width: 30 },
  ];

  for (const row of SAMPLE_ROWS) {
    worksheet.addRow(row);
  }

  worksheet.getRow(1).font = { bold: true };

  const outPath = "./sample-recruiters.xlsx";
  await workbook.xlsx.writeFile(outPath);
  console.log(`Sample sheet written to ${outPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
