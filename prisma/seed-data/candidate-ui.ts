// Copied from prep-candidate-ui/lib/data/{roles,cards,questions}.ts. Category labels are the UI's;
// prisma/seed.ts maps them to the CardCategory enum. Question card links differ from the UI mock
// where its cardId pointed at an unrelated card: the linked card is the question's default rubric.

export type UiRole = { slug: string; title: string; blurb: string };
export type UiCard = {
  category: string;
  question: string;
  strong: string[];
  tip: string;
  mistakes: string[];
};
/** `cardPosition` is the candidate UI's 1-based cardId. */
export type UiQuestion = { text: string; cardPosition: number };

export const UI_ROLES: UiRole[] = [
  {
    slug: 'junior-data-analyst',
    title: 'Junior Data Analyst',
    blurb: 'Turn raw data into clear reports that help teams decide.',
  },
  {
    slug: 'sales-development-rep',
    title: 'Sales Development Rep',
    blurb: 'Find and qualify new leads, then book calls for the sales team.',
  },
  {
    slug: 'customer-support-associate',
    title: 'Customer Support Associate',
    blurb:
      'Help customers by chat, email and phone, and calm tricky situations.',
  },
];

export const UI_CARDS: Record<string, UiCard[]> = {
  'junior-data-analyst': [
    {
      category: 'Behavioural',
      question: 'Tell me about yourself and why you want to be a data analyst.',
      strong: [
        'A short story of how you got interested in data',
        'One or two relevant skills, such as SQL, Excel or storytelling',
        'What you want to do with data in this role',
      ],
      tip: 'Keep it to about a minute and end on why this team.',
      mistakes: [
        'Listing every tool you have touched',
        'Saying you like numbers with no example',
      ],
    },
    {
      category: 'Technical',
      question:
        'Walk me through how you would clean a messy dataset before analysis.',
      strong: [
        'Profile first: missing values, duplicates, odd ranges',
        'Fix it in a repeatable way, like a script, not by hand',
        'Check the cleaned totals still match the source',
      ],
      tip: 'Name the tools you would use, such as SQL or pandas, and say why.',
      mistakes: [
        'Dropping rows with missing values without saying why',
        'Listing steps with no example from your own work',
      ],
    },
    {
      category: 'Technical',
      question: 'How do you decide which chart to use for a set of numbers?',
      strong: [
        'Start from the question: comparison, trend, share or spread',
        'Match the chart: bars to compare, lines for time, tables for exact values',
        'Keep it simple and label it so the point is obvious in five seconds',
      ],
      tip: 'Give one concrete example from a report you built.',
      mistakes: [
        'Choosing a chart because it looks impressive',
        'Not mentioning the audience',
      ],
    },
    {
      category: 'Behavioural',
      question: 'Tell me about a time you found an error in a dataset.',
      strong: [
        'How you spotted it: the check or number that looked wrong',
        'What you did: traced the cause, fixed it, told the people affected',
        'The result, ideally with a number, and how you stopped it recurring',
      ],
      tip: 'Pick an error that changed a decision or a report, not a simple typo.',
      mistakes: [
        'Blaming a colleague or the source system',
        'Stopping at the fix and skipping the result',
      ],
    },
    {
      category: 'Communication',
      question:
        "How would you explain a finding to someone who isn't technical?",
      strong: [
        'Lead with the answer, then the evidence',
        'Use plain words and one clear visual',
        'Say what you recommend they do next',
      ],
      tip: 'Practise a one-sentence headline for every analysis you do.',
      mistakes: [
        'Walking through the method before the answer',
        'Using terms like "p-value" without explaining them',
      ],
    },
    {
      category: 'Technical',
      question: 'What is the difference between an inner join and a left join?',
      strong: [
        'Inner join keeps only rows that match in both tables',
        'Left join keeps every row from the left table, with blanks where nothing matches',
        'A quick example, such as customers and their orders',
      ],
      tip: 'Use a tiny example you can say aloud rather than reciting definitions.',
      mistakes: [
        'Mixing up which table is the left one',
        'Forgetting that unmatched rows become blanks',
      ],
    },
    {
      category: 'Situational',
      question:
        'Two reports show different numbers for the same metric. What do you do?',
      strong: [
        'Compare definitions, date ranges and filters first',
        'Trace each number back to its source',
        'Agree one definition with the owners and document it',
      ],
      tip: 'Say that you would tell stakeholders early, not wait until it is solved.',
      mistakes: [
        'Picking the number you like better',
        'Fixing it quietly without telling anyone',
      ],
    },
    {
      category: 'Behavioural',
      question:
        'Tell me about a project where you used data to help make a decision.',
      strong: [
        'The decision and who needed it',
        'What data you used and what you found',
        'What was decided and what changed',
      ],
      tip: 'Include one number that shows the impact.',
      mistakes: [
        'Describing the analysis but not the decision',
        'Taking all the credit for a team effort',
      ],
    },
    {
      category: 'Technical',
      question: 'How do you check that your analysis is correct?',
      strong: [
        'Sanity-check totals and ranges against a known source',
        'Test edge cases and re-run with a second method where possible',
        'Ask a colleague to review before sharing',
      ],
      tip: 'Give a real example where a check caught a problem.',
      mistakes: [
        'Saying you are always careful',
        'Skipping checks when short on time',
      ],
    },
    {
      category: 'Situational',
      question:
        'A manager asks for a report by tomorrow but the data is incomplete. What do you do?',
      strong: [
        'Say what you can deliver and what is missing',
        'Offer a clearly labelled draft with caveats',
        'Agree when the full version will follow',
      ],
      tip: 'Being clear about limits builds trust. Do not hide gaps.',
      mistakes: [
        'Presenting incomplete data as final',
        'Saying it cannot be done without offering options',
      ],
    },
    {
      category: 'Communication',
      question: 'How do you handle feedback on your analysis?',
      strong: [
        'Listen and ask questions to understand the concern',
        'Check the point against the data before agreeing or disagreeing',
        'Update your work and say what changed',
      ],
      tip: 'Give an example where feedback improved the result.',
      mistakes: [
        'Getting defensive',
        'Agreeing to everything without checking',
      ],
    },
    {
      category: 'Closing',
      question: 'Why should we hire you, and what would you like to ask us?',
      strong: [
        'Two or three strengths tied to the role',
        'One short example that proves your main strength',
        "A question about the team's data, tools or priorities",
      ],
      tip: 'Ask what a successful first six months looks like.',
      mistakes: ['Repeating your CV', 'Having no questions'],
    },
  ],
  'sales-development-rep': [
    {
      category: 'Behavioural',
      question:
        'Tell me about yourself and why you want to work in sales development.',
      strong: [
        'A short story of what drew you to sales',
        'One or two strengths: resilience, curiosity or clear communication',
        'Why this product and this company',
      ],
      tip: 'Keep it to about a minute and finish with what you want to learn.',
      mistakes: [
        'Reciting your CV',
        'Saying you are a people person with no example',
      ],
    },
    {
      category: 'Behavioural',
      question: 'Tell me about a time you were rejected and how you responded.',
      strong: [
        'What happened, briefly and honestly',
        'What you did next: asked for feedback, adjusted your approach',
        'What changed as a result',
      ],
      tip: 'Show that rejection makes you more curious, not discouraged.',
      mistakes: [
        'Blaming the other person',
        'Pretending rejection never bothers you',
      ],
    },
    {
      category: 'Situational',
      question:
        "How would you open a cold call to someone who doesn't know us?",
      strong: [
        'A short, honest opener that says who you are and why you are calling',
        'A reason that matters to them, based on research',
        'A small, easy ask, such as 15 minutes',
      ],
      tip: 'Ask for permission: "Have you got 30 seconds?" It shows respect.',
      mistakes: [
        'Launching into a long pitch',
        'Using a script that sounds read out',
      ],
    },
    {
      category: 'Technical',
      question: 'How do you research a prospect before reaching out?',
      strong: [
        'Their role, company news and likely challenges',
        'Tools you would use, such as LinkedIn and the company website',
        'One specific detail you will use in your message',
      ],
      tip: 'Aim for five focused minutes rather than an hour of reading.',
      mistakes: [
        'Sending the same message to everyone',
        'Researching but never using it',
      ],
    },
    {
      category: 'Situational',
      question: 'A prospect says "send me some information". What do you do?',
      strong: [
        'Say yes, then ask one question to make it useful',
        'Send something short and relevant to their answer',
        'Agree a clear next step and date',
      ],
      tip: 'Treat it as a soft no and gently look for the real interest.',
      mistakes: [
        'Sending a generic brochure and waiting',
        'Pushing back so hard it feels rude',
      ],
    },
    {
      category: 'Behavioural',
      question: 'Tell me about a goal you hit and how you did it.',
      strong: [
        'The goal and how it was measured',
        'The habits or actions that made the difference',
        'The result, with a number',
      ],
      tip: 'Numbers matter in sales. Share one.',
      mistakes: [
        'Vague claims like "I did well"',
        'Not saying what you personally did',
      ],
    },
    {
      category: 'Situational',
      question: 'How do you qualify whether a lead is worth passing on?',
      strong: [
        'Need: do they have a problem we solve?',
        'Authority and budget: can they decide or influence?',
        'Timing: is there a reason to act soon?',
      ],
      tip: 'Mention that you also pass on context, not just a name.',
      mistakes: [
        'Passing on every lead',
        'Skipping questions out of fear of seeming pushy',
      ],
    },
    {
      category: 'Communication',
      question: 'How would you write a short email to a busy decision maker?',
      strong: [
        'A clear subject line and a first line about them',
        'One benefit and one proof point',
        'A single, simple ask',
      ],
      tip: 'Read it aloud. If it takes over 30 seconds, trim it.',
      mistakes: [
        'Writing a long email about the product',
        'Ending with several questions',
      ],
    },
    {
      category: 'Situational',
      question:
        'How do you handle the objection "we\'re happy with what we use"?',
      strong: [
        'Acknowledge it and avoid arguing',
        'Ask what they like and what they would change',
        'Offer a small next step with no pressure',
      ],
      tip: 'Curiosity beats persuasion in a first conversation.',
      mistakes: [
        'Criticising their current tool',
        'Giving up after the first no',
      ],
    },
    {
      category: 'Behavioural',
      question:
        'How do you organise your day when you have a lot of outreach to do?',
      strong: [
        'Block time for calls and emails',
        'Prioritise the warmest leads first',
        'Track follow-ups in a CRM so none are missed',
      ],
      tip: 'Mention a real system you used, even a spreadsheet.',
      mistakes: ['Having no system', 'Spending all day on research'],
    },
    {
      category: 'Communication',
      question:
        'How do you keep your energy up after a run of unanswered calls?',
      strong: [
        'Treat it as numbers: every call is progress towards a yes',
        'Review what is working and adjust',
        'Take short breaks and celebrate small wins',
      ],
      tip: 'Be honest that it is tough, and say what you do about it.',
      mistakes: [
        'Saying it never gets to you',
        'Becoming discouraged and calling less',
      ],
    },
    {
      category: 'Closing',
      question: 'Why should we hire you, and what would you like to ask us?',
      strong: [
        'Two or three strengths tied to the role',
        'A short example that proves your main strength',
        'A question about training, targets or career paths',
      ],
      tip: 'Ask how the team supports new reps in the first 90 days.',
      mistakes: ['Repeating your CV', 'Having no questions'],
    },
  ],
  'customer-support-associate': [
    {
      category: 'Behavioural',
      question:
        'Tell me about yourself and why you want to work in customer support.',
      strong: [
        'A short story: where you are now and what draws you to helping people',
        'One or two strengths that fit the job, such as patience or clear writing',
        'Why this company and this role, in a sentence',
      ],
      tip: 'Keep it to about a minute and finish on why you are excited about this job.',
      mistakes: [
        'Reading your CV out loud from start to finish',
        'Saying you just like people without an example',
      ],
    },
    {
      category: 'Behavioural',
      question:
        'Tell me about a time you handled an upset customer. What did you do?',
      strong: [
        'Acknowledge how the customer felt before you try to fix anything',
        'What you did next: found the cause, explained it, and took ownership',
        'How it ended, and that the customer left feeling looked after',
      ],
      tip: 'Say the feeling out loud: "I can see why that was frustrating." It lowers the temperature fast.',
      mistakes: [
        'Jumping straight to the policy or a fix',
        'Blaming the customer or another team',
      ],
    },
    {
      category: 'Situational',
      question: "How would you handle a question you don't know the answer to?",
      strong: [
        'Be honest that you are not sure, calmly and without apology',
        'Say how you will find out: a colleague, the help centre, or an escalation',
        'Tell the customer when they will hear back, then follow up',
      ],
      tip: 'A clear "I\'ll find out and come back to you by 3pm" builds more trust than a guess.',
      mistakes: [
        'Guessing and hoping nobody notices',
        'Leaving the customer waiting with no update',
      ],
    },
    {
      category: 'Behavioural',
      question:
        'Tell me about a time you explained something complicated simply.',
      strong: [
        'Who you were explaining to and what they needed to understand',
        'How you simplified it: plain words, an example, or a step-by-step',
        'End with what you learned about explaining things, and how you check it landed',
      ],
      tip: 'Finish every story with one sentence on what you learned or would do again.',
      mistakes: [
        'Using jargon the customer would not know',
        'Stopping at the explanation with no lesson',
      ],
    },
    {
      category: 'Behavioural',
      question:
        "Tell me about a time a customer's problem took a while to solve.",
      strong: [
        'What the problem was and why it was hard',
        'Clear steps you took and how you kept the customer informed',
        'A clear outcome: what changed for the customer, ideally with a number',
      ],
      tip: 'Say how things turned out in plain terms, such as "the refund arrived the next day".',
      mistakes: [
        'Describing effort but never saying how it ended',
        'Leaving out your own part and saying "we" throughout',
      ],
    },
    {
      category: 'Situational',
      question:
        "How do you stay calm when there's a long queue of customers waiting?",
      strong: [
        'A habit you use: take a breath, work one customer at a time',
        'How you prioritise, such as urgent or simple cases first',
        'How you ask for help or flag a backlog early',
      ],
      tip: 'Give a real example of a busy day and what you did, not just "I stay calm".',
      mistakes: [
        'Saying you never feel stressed',
        'Rushing customers to get through the queue',
      ],
    },
    {
      category: 'Situational',
      question: "A customer asks for something we can't do. What do you say?",
      strong: [
        "Say what you can do first, then what you can't, kindly and clearly",
        'Explain the reason in a sentence without hiding behind policy',
        'Offer an alternative or the next step',
      ],
      tip: 'Lead with the help you can give so the answer does not start with "no".',
      mistakes: [
        'A flat "that\'s not possible" with nothing after it',
        'Promising something you cannot deliver',
      ],
    },
    {
      category: 'Behavioural',
      question:
        'Tell me about a time you went beyond what was asked for a customer.',
      strong: [
        'What the customer first asked for and what you noticed they also needed',
        'The extra step you took and why you chose it',
        'How the customer reacted or what it prevented',
      ],
      tip: 'Pick a small, genuine example. It does not have to be dramatic.',
      mistakes: [
        'Choosing an example that broke a rule',
        'Describing it with no result',
      ],
    },
    {
      category: 'Behavioural',
      question:
        'Give me an example from your own work where you helped a customer.',
      strong: [
        'A real customer situation from a job, school, volunteering or a shop',
        'Specific details: what they needed and what you did',
        'What the customer said or did afterwards',
      ],
      tip: 'Real examples beat general claims. Use one from your own experience, even if it was informal.',
      mistakes: [
        'Speaking in generalities like "I always help"',
        'Making up an example you cannot explain',
      ],
    },
    {
      category: 'Situational',
      question:
        'How would you handle a customer who keeps contacting us about the same issue?',
      strong: [
        'Review the history so the customer does not have to repeat themselves',
        'Find the root cause or escalate to someone who can fix it',
        'Agree on a follow-up and keep your promise',
      ],
      tip: 'Show you take ownership of the whole problem, not just this one message.',
      mistakes: [
        'Answering each message as if it were new',
        'Closing the ticket before the issue is fixed',
      ],
    },
    {
      category: 'Communication',
      question:
        'How would you speak to a customer on the phone compared with by chat?',
      strong: [
        'Phone: warm tone, slower pace and checking you understood',
        'Chat: short clear messages, no long waits, and a summary at the end',
        'Adjust to the customer, whichever channel they pick',
      ],
      tip: 'Mind your pace and filler words. Slow down to roughly 120 to 160 words a minute.',
      mistakes: [
        'Speaking quickly and filling gaps with "um" and "you know"',
        'Sending a wall of text in chat',
      ],
    },
    {
      category: 'Closing',
      question:
        'Why should we hire you for this role, and do you have any questions for us?',
      strong: [
        'Two or three reasons, each tied to something the job needs',
        'A short example that backs up your main strength',
        'One or two thoughtful questions about training, the team or how success is measured',
      ],
      tip: 'Prepare your questions in advance and ask the one you most want answered.',
      mistakes: [
        'Repeating your CV without linking it to the role',
        'Saying you have no questions',
      ],
    },
  ],
};

export const UI_QUESTIONS: Record<string, UiQuestion[]> = {
  'junior-data-analyst': [
    {
      text: 'Tell me about yourself and why you want to work in data analysis.',
      cardPosition: 1,
    },
    {
      text: 'Tell me about a time you found something surprising in a set of data. What did you do?',
      cardPosition: 4,
    },
    {
      text: 'How would you check that a dataset is clean before you analyse it?',
      cardPosition: 2,
    },
    {
      text: "Tell me about a time you explained numbers to someone who isn't technical.",
      cardPosition: 5,
    },
    {
      text: 'How do you decide what to do first when several requests arrive at once?',
      cardPosition: 10,
    },
  ],
  'sales-development-rep': [
    {
      text: 'Tell me about yourself and why you want to work in sales.',
      cardPosition: 1,
    },
    {
      text: 'Tell me about a time you were turned down. What did you do next?',
      cardPosition: 2,
    },
    {
      text: 'How would you start a conversation with someone who has never heard of us?',
      cardPosition: 3,
    },
    {
      text: 'Tell me about a time you kept going on a hard goal.',
      cardPosition: 6,
    },
    {
      text: 'How do you stay motivated after a day of hearing no?',
      cardPosition: 11,
    },
  ],
  'customer-support-associate': [
    {
      text: 'Tell me about yourself and why you want to work in customer support.',
      cardPosition: 1,
    },
    {
      text: 'Tell me about a time you handled an upset customer. What did you do?',
      cardPosition: 2,
    },
    {
      text: "How would you handle a question you don't know the answer to?",
      cardPosition: 3,
    },
    {
      text: 'Tell me about a time you explained something complicated simply.',
      cardPosition: 4,
    },
    {
      text: "How do you stay calm when there's a long queue of customers waiting?",
      cardPosition: 6,
    },
  ],
};
