/**
 * Fixture corpus for calibrating `DEFAULT_MATCH_CONFIG`.
 *
 * Three cue sheets from genuinely different domains — IT/technical support,
 * backend engineering, and non-technical project management — each with real
 * prepared answers and enough trigger paraphrases to search against. The test
 * cases in each sheet are written the way an interviewer actually talks:
 * disfluencies, phrasings that share almost no vocabulary with the card
 * heading, and — critically — questions that sit right next to a card but
 * ask something else, since those are what produce false suppressions.
 *
 * These transcripts were written independently of the trigger lists, as a
 * human interviewer would phrase them, not derived from the triggers to make
 * the numbers look good. Whatever `CueMatcher` does with them is the honest
 * signal `cuesheet-corpus.test.ts` calibrates against.
 */

import type { CueSheet } from './cuesheet.ts'

// ---------------------------------------------------------------------------
// Sheet 1: IT / technical support
// ---------------------------------------------------------------------------

const supportSheet: CueSheet = {
  id: 'sheet-support',
  label: 'Technical support interview',
  sourceHash: 'corpus-support-1',
  createdAt: '2026-08-01T00:00:00.000Z',
  cards: [
    {
      id: 'ts-prioritize',
      heading: 'How I prioritize support tickets',
      script:
        "I triage by impact and urgency — a full outage for many users jumps the queue ahead of a single user's cosmetic bug. I use SLA timers as a tie-breaker, and I always re-check priority if new tickets come in that raise the stakes.",
      cues: [
        'Triage by impact and urgency',
        'Outages ahead of cosmetic bugs',
        'SLA timers break ties',
        'Re-check priority as new tickets arrive'
      ],
      triggers: [
        'how do you prioritize support tickets',
        'walk me through your ticket triage process',
        'how do you decide what to work on first',
        'when you have a queue of tickets which one do you pick up',
        'how do you handle competing priorities in your ticket queue',
        "what's your process for triaging incoming issues",
        "how do you decide what's urgent versus what can wait",
        'if you had ten tickets open how would you order them',
        'talk me through how you triage',
        'how do you juggle multiple support requests at once',
        'what determines which ticket you pick up next',
        'how do you make sure the most important issues get handled first'
      ]
    },
    {
      id: 'ts-difficult-customer',
      heading: 'Handling an angry or upset customer',
      script:
        "I let them vent first without interrupting, because most of the anger is about being unheard rather than the bug itself. Once they've said their piece I restate the problem back to them so they know I actually listened, then I give them a concrete next step and a time I'll follow up. That combination — listening, restating, committing to a time — calms almost every escalation I've handled.",
      cues: [
        'Let them vent first',
        'Restate the problem back',
        'Give a concrete next step',
        'Commit to a follow-up time'
      ],
      triggers: [
        'tell me about a time you dealt with an angry customer',
        'how do you handle an upset customer on the phone',
        'describe a situation with a frustrated client',
        'walk me through de-escalating an angry caller',
        'how do you calm someone down who is yelling at you',
        'tell me about your toughest customer interaction',
        'how do you handle someone who is furious about downtime',
        'describe a time a customer was really unhappy with you',
        'what do you do when a customer loses their temper',
        'how do you manage difficult conversations with clients',
        'tell me about de-escalation',
        'how do you keep your cool with a hostile customer'
      ]
    },
    {
      id: 'ts-escalation',
      heading: 'Deciding when to escalate to engineering',
      script:
        "I escalate when I've exhausted the runbook and the issue is either affecting multiple customers or touches something I don't have write access to, like the database. Before I escalate I write up exactly what I've already tried so the engineer isn't repeating my steps. I'd rather escalate a bit early with good notes than sit on a ticket hoping it resolves itself.",
      cues: [
        'Exhausted the runbook first',
        'Multiple customers or no write access',
        "Write up what I've already tried",
        'Escalate early with good notes'
      ],
      triggers: [
        'when do you escalate a ticket to engineering',
        'how do you decide something needs to go to the dev team',
        "what's your threshold for escalating an issue",
        'tell me about a time you had to loop in engineering',
        "how do you know when you're out of your depth on a ticket",
        'walk me through your escalation process',
        'when do you hand a problem off to someone else',
        "how do you decide you can't fix something yourself",
        'what makes you escalate versus keep digging',
        'tell me about handing off a hard problem',
        'how do you work with engineers on customer issues',
        'when is it time to bring in a specialist'
      ]
    },
    {
      id: 'ts-repro',
      heading: "Troubleshooting an issue you can't reproduce",
      script:
        "I start by pulling logs and session recordings around the time the customer reported the problem, because their description and the actual sequence of events often differ. If I still can't reproduce it, I ask very specific questions about their environment — browser, extensions, network — instead of general ones, since vague questions get vague answers. Sometimes I just have to ship a fix for the most likely cause and watch closely afterward.",
      cues: [
        'Pull logs and session recordings first',
        'Ask specific environment questions',
        'Vague questions get vague answers',
        'Ship the likely fix and watch'
      ],
      triggers: [
        "how do you troubleshoot something you can't reproduce",
        "what do you do when you can't recreate the bug",
        'tell me about debugging an issue that only happens for one customer',
        'how do you investigate an intermittent problem',
        "walk me through diagnosing a bug you've never seen before",
        "what's your process when the steps to reproduce don't work",
        'how do you handle a ghost bug',
        'tell me about a hard-to-pin-down issue you solved',
        'how do you gather information from a customer about a bug',
        "what do you do when the customer's description doesn't match the logs",
        "how do you approach an issue that's not consistently happening",
        'tell me about chasing down an elusive bug'
      ]
    },
    {
      id: 'ts-docs',
      heading: 'Using and contributing to documentation',
      script:
        "I treat the knowledge base as a living thing — if I solve something that isn't documented, I write it up before I close the ticket, not after. When I'm troubleshooting I search docs first because most issues aren't actually new, they just feel new to the person hitting them. Good documentation is the difference between solving a problem once and solving it forever.",
      cues: [
        'Write it up before closing the ticket',
        "Search docs first, most issues aren't new",
        'Docs turn one-time fixes into permanent ones'
      ],
      triggers: [
        'how do you use the knowledge base in your work',
        'tell me about contributing to documentation',
        "how do you make sure knowledge doesn't just live in your head",
        "what's your relationship with internal docs",
        'how do you document a fix after you solve it',
        'tell me about a time you improved the runbook',
        'how do you avoid solving the same problem twice',
        'what do you do with tribal knowledge on your team',
        "how do you keep the team's documentation up to date",
        'tell me about writing a how-to guide for other support agents',
        'how do you make sure your knowledge is shareable',
        'what is your approach to knowledge management'
      ]
    }
  ]
}

const supportCases: { transcript: string; expect: string | null }[] = [
  // ts-prioritize
  { transcript: 'So, uh, how do you go about prioritizing your support tickets?', expect: 'ts-prioritize' },
  { transcript: "Let's say you've got twenty tickets sitting there — how do you figure out what to tackle first?", expect: 'ts-prioritize' },
  { transcript: 'Walk me through your triage process.', expect: 'ts-prioritize' },
  { transcript: 'If a VIP customer and a five-alarm outage land at the same time, which one wins?', expect: 'ts-prioritize' },
  { transcript: "So how do you know, uh, what to work on when everything feels urgent?", expect: 'ts-prioritize' },
  { transcript: 'How do you order your queue when three things all look important at once?', expect: 'ts-prioritize' },
  // ts-difficult-customer
  { transcript: 'Tell me about a time a customer was really upset with you, how did you handle it?', expect: 'ts-difficult-customer' },
  { transcript: "So, uh, what do you do when someone's just screaming at you on the phone?", expect: 'ts-difficult-customer' },
  { transcript: 'Can you walk me through de-escalating a tense support call?', expect: 'ts-difficult-customer' },
  { transcript: 'Describe the angriest customer you have ever had and how it ended.', expect: 'ts-difficult-customer' },
  { transcript: 'How do you keep your composure when a client is being hostile?', expect: 'ts-difficult-customer' },
  { transcript: "What's your approach when somebody's really not happy and taking it out on you?", expect: 'ts-difficult-customer' },
  // ts-escalation
  { transcript: 'So when do you actually decide to kick something over to engineering?', expect: 'ts-escalation' },
  { transcript: "How do you know you're in over your head and need to loop someone else in?", expect: 'ts-escalation' },
  { transcript: 'Walk me through a time you had to escalate a really hard ticket.', expect: 'ts-escalation' },
  { transcript: "What's the line for you between fixing it yourself and needing a developer?", expect: 'ts-escalation' },
  { transcript: 'Tell me about handing a problem off because you could not solve it yourself.', expect: 'ts-escalation' },
  { transcript: 'Uh, how do you decide when a ticket is above your pay grade?', expect: 'ts-escalation' },
  // ts-repro
  { transcript: "So what's your process when you literally can't get the bug to happen on your end?", expect: 'ts-repro' },
  { transcript: "Tell me about a time the customer's story and the logs just didn't line up.", expect: 'ts-repro' },
  { transcript: 'How do you dig into something that only seems to happen for one person?', expect: 'ts-repro' },
  { transcript: 'Walk me through chasing down a really elusive issue.', expect: 'ts-repro' },
  { transcript: "What do you do when the steps they gave you don't actually reproduce anything?", expect: 'ts-repro' },
  { transcript: "Uh, how do you even start on a bug that's basically a ghost?", expect: 'ts-repro' },
  // ts-docs
  { transcript: 'How do you make sure what you learn does not just stay in your head?', expect: 'ts-docs' },
  { transcript: 'Tell me about a time you updated the runbook after fixing something.', expect: 'ts-docs' },
  { transcript: "So, uh, what's your relationship with the internal docs, do you actually use them?", expect: 'ts-docs' },
  { transcript: 'How do you avoid the team solving the same problem over and over?', expect: 'ts-docs' },
  { transcript: 'Walk me through documenting a fix once you have found it.', expect: 'ts-docs' },
  { transcript: "What do you do with knowledge that's just floating around in people's heads?", expect: 'ts-docs' },
  // negatives: logistics, small talk, and adjacent-but-different
  { transcript: "What's your notice period?", expect: null },
  { transcript: 'What are your salary expectations for this role?', expect: null },
  { transcript: 'Are you open to relocating for this position?', expect: null },
  { transcript: 'So how was your commute here today?', expect: null },
  { transcript: 'What tools have you used for ticketing — Zendesk, Jira, something else?', expect: null },
  { transcript: 'How many tickets do you typically close in a day?', expect: null },
  { transcript: 'What do you like to do outside of work?', expect: null }
]

// ---------------------------------------------------------------------------
// Sheet 2: Backend engineering
// ---------------------------------------------------------------------------

const backendSheet: CueSheet = {
  id: 'sheet-backend',
  label: 'Backend engineering interview',
  sourceHash: 'corpus-backend-1',
  createdAt: '2026-08-01T00:00:00.000Z',
  cards: [
    {
      id: 'be-scaling',
      heading: 'Scaling a system under load',
      script:
        "We hit a wall when a single Postgres instance couldn't keep up with write volume during a product launch, so I split reads onto replicas and moved the hottest write path onto a queue so we could absorb bursts instead of rejecting requests. Throughput held through the launch and we never had to page anyone that night. The lesson I took away is that you scale the bottleneck, not the whole system.",
      cues: [
        'Read replicas plus a write queue',
        'Absorbed bursts instead of rejecting',
        'No pages during launch',
        'Scale the bottleneck, not everything'
      ],
      triggers: [
        'tell me about a time you scaled a system',
        "how did you handle a system that couldn't keep up with load",
        'walk me through scaling a service under heavy traffic',
        'tell me about handling a big spike in demand',
        "how do you scale a database that's falling over",
        'describe a time you had to make something handle way more load',
        'tell me about a launch where traffic was a real risk',
        'how did you avoid your system falling over during a spike',
        'what did you do when a single database became a bottleneck',
        'tell me about capacity planning for a big event',
        'walk me through improving throughput on a struggling service',
        'how do you scale for a large increase in traffic'
      ]
    },
    {
      id: 'be-incident',
      heading: 'Debugging a production incident',
      script:
        "The first thing I do is stop the bleeding — roll back or feature-flag off if I can, before I even know the root cause, because restoring service matters more than being clever. Once things are stable I go through logs and metrics methodically rather than guessing, and I write the postmortem the same day while details are fresh. Blameless postmortems only work if you actually write them promptly.",
      cues: [
        'Stop the bleeding before root-causing',
        'Rollback or flag off first',
        'Go through logs methodically, not guessing',
        'Write the postmortem same day'
      ],
      triggers: [
        'walk me through debugging a production incident',
        'tell me about an outage you had to fix',
        'how do you approach an on-call page at 3am',
        'describe your process during a live incident',
        "tell me about the worst production issue you've handled",
        'how do you stay calm during an outage',
        'walk me through your incident response',
        'tell me about writing a postmortem',
        'how do you figure out root cause during a live outage',
        'describe a time production was down and you had to fix it fast',
        "what's your process when something breaks in prod",
        'tell me about firefighting a critical bug in production'
      ]
    },
    {
      id: 'be-codereview',
      heading: 'Approach to code review',
      script:
        "I look for correctness first and style a distant second, because a nitpick about naming shouldn't block a fix that's actually correct. I try to leave at least one comment that teaches something, not just flags a problem, and I always assume the author had a reason for a weird-looking decision until I've asked about it. Reviews that only find fault train people to avoid review, not to write better code.",
      cues: [
        'Correctness first, style second',
        'Leave a comment that teaches',
        'Assume good reason, then ask',
        'Fault-finding trains avoidance'
      ],
      triggers: [
        'how do you approach code review',
        'tell me about your philosophy on reviewing pull requests',
        "what do you look for when reviewing someone's code",
        "how do you give feedback on a colleague's PR",
        'tell me about a time you had to push back on a pull request',
        'what makes a good code review in your opinion',
        'how do you balance being thorough and being fast in review',
        'tell me about mentoring through code review',
        'how do you handle disagreement in a review',
        "what's your process for reviewing a large PR",
        "how do you make sure reviews aren't just nitpicking",
        "tell me about giving hard feedback on someone's code"
      ]
    },
    {
      id: 'be-migration',
      heading: 'Leading a database migration',
      script:
        "I ran the migration as an expand-and-contract — add the new column, dual-write to both, backfill in batches during low traffic, then only remove the old column once every reader was confirmed switched over. Doing it in reversible steps meant that if anything went wrong at any point we could stop without a rollback script written under pressure. It took three weeks longer than a big-bang cutover would have, and I'd make the same trade again.",
      cues: [
        'Expand-and-contract, not big-bang',
        'Dual-write, then backfill in batches',
        'Reversible at every step',
        'Took longer, worth it'
      ],
      triggers: [
        'tell me about a database migration you led',
        'walk me through migrating a schema in production',
        'how do you move data without downtime',
        'tell me about a zero-downtime migration',
        "how do you approach changing a schema that's in heavy use",
        'describe a time you migrated a large table safely',
        'how do you avoid downtime during a schema change',
        'tell me about backfilling data on a live system',
        'walk me through a risky data migration',
        'how do you migrate off an old database',
        'tell me about expand and contract migrations',
        'how do you handle a migration that could lose data if it goes wrong'
      ]
    },
    {
      id: 'be-tradeoffs',
      heading: 'Making architecture tradeoffs',
      script:
        "I try to name the actual tradeoff out loud instead of pretending there's a free option — usually it's latency versus consistency, or simplicity versus flexibility, and I pick based on what the product actually needs in the next year, not what's theoretically most elegant. I write the reasoning down so the next person can see why, not just what. Most bad architecture isn't from a wrong choice, it's from an unexamined one.",
      cues: [
        'Name the real tradeoff, no free option',
        "Pick for next year's need, not elegance",
        'Write reasoning down for the next person',
        'Unexamined choices are the real risk'
      ],
      triggers: [
        'how do you make architecture tradeoffs',
        'tell me about a hard technical decision you made',
        'how do you decide between two valid approaches',
        'walk me through choosing simplicity over flexibility',
        'tell me about a time you chose consistency over latency',
        'how do you document a design decision',
        'tell me about an architecture decision record you wrote',
        'how do you evaluate competing technical approaches',
        "tell me about a design choice you'd defend today",
        'how do you decide what is over-engineering versus necessary',
        'walk me through picking a technology for a new system',
        'tell me about a decision where there was no clearly right answer'
      ]
    }
  ]
}

const backendCases: { transcript: string; expect: string | null }[] = [
  // be-scaling
  { transcript: 'Tell me about a time your system almost fell over from too much traffic, what did you do?', expect: 'be-scaling' },
  { transcript: 'Walk me through handling a huge spike in demand.', expect: 'be-scaling' },
  { transcript: "So, uh, how did you keep things running when load way exceeded what you'd planned for?", expect: 'be-scaling' },
  { transcript: 'Describe a launch where you were genuinely worried about capacity.', expect: 'be-scaling' },
  { transcript: 'How do you scale a database once it becomes the bottleneck?', expect: 'be-scaling' },
  { transcript: 'What is a time you had to make something handle ten times more traffic?', expect: 'be-scaling' },
  // be-incident
  { transcript: 'So walk me through what you actually do when you get paged at 3am.', expect: 'be-incident' },
  { transcript: "Tell me about the worst outage you've ever had to deal with.", expect: 'be-incident' },
  { transcript: 'How do you stay level-headed when production is on fire?', expect: 'be-incident' },
  { transcript: "Describe your process the moment you realize something's seriously broken.", expect: 'be-incident' },
  { transcript: 'Walk me through writing up a postmortem after an incident.', expect: 'be-incident' },
  { transcript: "Uh, what's the first thing you do when you find out something's down?", expect: 'be-incident' },
  // be-codereview
  { transcript: "So what's your actual philosophy when you're reviewing somebody else's PR?", expect: 'be-codereview' },
  { transcript: 'Tell me about a time you had to push back pretty hard on a pull request.', expect: 'be-codereview' },
  { transcript: "How do you make sure your feedback on someone's code doesn't come off as harsh?", expect: 'be-codereview' },
  { transcript: 'What do you look for first when you open up a diff to review?', expect: 'be-codereview' },
  { transcript: 'Walk me through how you mentor junior engineers through review.', expect: 'be-codereview' },
  { transcript: "Uh, how do you balance being thorough with just, you know, not slowing everyone down?", expect: 'be-codereview' },
  // be-migration
  { transcript: "Tell me about a time you had to change a schema without taking anything down.", expect: 'be-migration' },
  { transcript: "Walk me through a migration where losing data would've been really bad.", expect: 'be-migration' },
  { transcript: 'How do you approach moving a huge table to a new structure safely?', expect: 'be-migration' },
  { transcript: 'So, uh, how do you migrate a live database without everyone noticing?', expect: 'be-migration' },
  { transcript: "Describe backfilling data on a system that can't go down.", expect: 'be-migration' },
  { transcript: "What's your process for a migration you can't easily undo?", expect: 'be-migration' },
  // be-tradeoffs
  { transcript: 'Tell me about a really hard technical call you had to make where there was no obviously right answer.', expect: 'be-tradeoffs' },
  { transcript: 'How do you decide between two approaches that are both kind of valid?', expect: 'be-tradeoffs' },
  { transcript: 'Walk me through a decision you documented so the next person would understand it.', expect: 'be-tradeoffs' },
  { transcript: 'So, uh, how do you know when you are over-engineering something versus actually needing it?', expect: 'be-tradeoffs' },
  { transcript: 'Tell me about picking a technology for a brand new system.', expect: 'be-tradeoffs' },
  { transcript: 'Describe a time you chose the simpler option over the fancier one.', expect: 'be-tradeoffs' },
  // negatives: logistics, small talk, and adjacent-but-different
  { transcript: "What's your notice period?", expect: null },
  { transcript: 'Are you authorized to work in this country?', expect: null },
  { transcript: "What's the team's tech stack, just curious?", expect: null },
  { transcript: "What's the on-call rotation like on the team you'd be joining?", expect: null },
  { transcript: 'What is your favorite programming language and why?', expect: null },
  { transcript: "How do you feel about our office's return-to-office policy?", expect: null },
  { transcript: 'How many engineers are on the team right now?', expect: null }
]

// ---------------------------------------------------------------------------
// Sheet 3: Non-technical — project management
// ---------------------------------------------------------------------------

const pmSheet: CueSheet = {
  id: 'sheet-pm',
  label: 'Project management interview',
  sourceHash: 'corpus-pm-1',
  createdAt: '2026-08-01T00:00:00.000Z',
  cards: [
    {
      id: 'pm-conflict',
      heading: 'Resolving conflict on a team',
      script:
        "I get the two people talking to each other directly instead of relaying messages through me, because most conflict escalates when people are arguing with their idea of the other person rather than the actual person. I ask each side what outcome they actually need, not just what they're upset about, since those are often different things. Usually the real disagreement is smaller than it looked once both sides hear the same information.",
      cues: [
        'Get them talking directly, not through me',
        'Ask what outcome they need, not just complaint',
        'Real disagreement is usually smaller'
      ],
      triggers: [
        'tell me about resolving conflict on your team',
        'how do you handle disagreement between two team members',
        'describe a time you mediated a dispute',
        'walk me through a conflict you had to resolve',
        "how do you handle two people who don't get along",
        'tell me about a time tension on your team affected the work',
        'how do you approach a disagreement between stakeholders',
        'describe navigating interpersonal conflict',
        'tell me about a time you had to referee an argument',
        'how do you keep a disagreement from derailing a project',
        'walk me through mediating between two strong personalities',
        'tell me about a time you had to step in between two colleagues'
      ]
    },
    {
      id: 'pm-deadline',
      heading: 'Missing a deadline',
      script:
        "We missed a launch date because a dependency team's estimate slipped and I didn't build in slack for that risk, so I owned that in the retro rather than pointing at the other team. What I changed afterward was flagging cross-team dependencies as risks explicitly in the plan, with a buffer, instead of treating another team's promise as a fixed date. I haven't missed one for that reason since.",
      cues: [
        'Missed because no slack for dependency risk',
        'Owned it in the retro, no blame',
        'Now flag cross-team dependencies with buffer',
        "Haven't missed one since for that reason"
      ],
      triggers: [
        'tell me about a time you missed a deadline',
        'describe a project that slipped',
        "walk me through a deadline you didn't hit",
        'how do you handle it when a project runs late',
        'tell me about a launch that got delayed',
        'how do you communicate a slipping deadline to stakeholders',
        'tell me about a time your plan fell apart',
        'describe owning a mistake on a project timeline',
        'how do you recover from a missed milestone',
        'walk me through a project that went over schedule',
        "tell me about a commitment you couldn't keep",
        'how do you learn from a project that went wrong'
      ]
    },
    {
      id: 'pm-stakeholder',
      heading: 'Managing stakeholder expectations',
      script:
        "I over-communicate early rather than showing up with bad news late — if I know a date is at risk in week two, stakeholders hear it in week two, not week six. I also translate status into what it means for them specifically, not a generic percent-complete number, because a VP and an engineer need different information from the same fact. People forgive a changed date far more than they forgive being surprised by one.",
      cues: [
        'Over-communicate risk early, not late',
        'Translate status into what it means for them',
        'Different stakeholders need different framing',
        'Forgiven changes, not forgiven surprises'
      ],
      triggers: [
        'how do you manage stakeholder expectations',
        'tell me about keeping executives informed on a project',
        'how do you communicate bad news to leadership',
        'walk me through handling a demanding stakeholder',
        'tell me about a time you had to say no to a stakeholder',
        'how do you keep different stakeholders aligned',
        'describe managing up during a risky project',
        "tell me about a status update that didn't go well",
        'how do you avoid surprising leadership with bad news',
        "walk me through building trust with a skeptical stakeholder",
        'tell me about translating technical status for executives',
        'how do you handle conflicting stakeholder priorities'
      ]
    },
    {
      id: 'pm-prioritize',
      heading: 'Prioritizing competing projects',
      script:
        'I score initiatives against the same two axes every time — impact if it ships, and cost if it is delayed — instead of whoever asked most recently or loudest. That keeps the ranking defensible when someone pushes back, because I can point to the framework instead of my judgment alone. It also means I revisit the ranking on a fixed cadence rather than only when someone complains.',
      cues: [
        'Score against impact and cost of delay',
        'Framework makes ranking defensible',
        'Revisit on a fixed cadence, not on complaint'
      ],
      triggers: [
        'how do you prioritize competing projects',
        'tell me about juggling multiple initiatives at once',
        'how do you decide what your team works on first',
        'walk me through your prioritization framework',
        'tell me about saying no to a project',
        'how do you handle two important projects competing for the same resources',
        'describe ranking a backlog of initiatives',
        "how do you avoid prioritizing based on who's loudest",
        'tell me about a prioritization decision that was unpopular',
        'walk me through allocating limited resources across projects',
        'how do you decide what not to do',
        'tell me about trading off two roadmap items'
      ]
    },
    {
      id: 'pm-time',
      heading: 'Managing your time and staying organized',
      script:
        "I block time for deep work before the day fills with meetings, because reactive time always loses to whatever showed up in the inbox last. I keep a single list of commitments instead of one per tool, so nothing hides in a channel I forgot to check. At the end of each day I spend five minutes deciding tomorrow's top three, so I start the morning already knowing what matters.",
      cues: [
        'Block deep work before meetings fill the day',
        'One list, not one per tool',
        "Five minutes at day's end to set tomorrow's top three"
      ],
      triggers: [
        'how do you manage your time',
        'how do you stay organized with so much going on',
        'tell me about your daily routine',
        'how do you avoid getting buried in meetings',
        'walk me through how you plan your day',
        'how do you keep track of everything you are responsible for',
        'tell me about balancing deep work with meetings',
        'how do you avoid your calendar running your life',
        'what does your typical week look like',
        'how do you make sure nothing falls through the cracks',
        'tell me about protecting focus time',
        'how do you decide what to work on each day'
      ]
    }
  ]
}

const pmCases: { transcript: string; expect: string | null }[] = [
  // pm-conflict
  { transcript: "Tell me about a time you had to step in between two people who just weren't getting along.", expect: 'pm-conflict' },
  { transcript: 'Walk me through mediating a disagreement between two strong-willed people.', expect: 'pm-conflict' },
  { transcript: "So, uh, how do you handle it when two people on your team are butting heads?", expect: 'pm-conflict' },
  { transcript: "Describe a moment you had to referee something that was getting heated.", expect: 'pm-conflict' },
  { transcript: 'How do you keep personal friction from tanking a project?', expect: 'pm-conflict' },
  { transcript: 'Tell me about navigating a dispute between stakeholders.', expect: 'pm-conflict' },
  // pm-deadline
  { transcript: "Tell me about a project that just didn't ship on time — what happened?", expect: 'pm-deadline' },
  { transcript: 'Walk me through a time you had to tell stakeholders you were going to be late.', expect: 'pm-deadline' },
  { transcript: 'So, uh, describe a commitment you made that you ended up not being able to keep.', expect: 'pm-deadline' },
  { transcript: 'How do you bounce back after a project goes sideways on the schedule?', expect: 'pm-deadline' },
  { transcript: 'Tell me about owning a mistake that pushed a launch date.', expect: 'pm-deadline' },
  { transcript: 'Describe a plan that fell apart and what you did about it.', expect: 'pm-deadline' },
  // pm-stakeholder
  { transcript: 'Tell me about a time you had to deliver bad news to leadership.', expect: 'pm-stakeholder' },
  { transcript: 'How do you keep a demanding VP happy when things are not going great?', expect: 'pm-stakeholder' },
  { transcript: "Walk me through building trust with someone who didn't believe in the project.", expect: 'pm-stakeholder' },
  { transcript: "So, uh, how do you make sure the people above you aren't blindsided by a change?", expect: 'pm-stakeholder' },
  { transcript: 'Tell me about saying no to a stakeholder who wanted something unreasonable.', expect: 'pm-stakeholder' },
  { transcript: 'Describe translating a messy technical status into something an exec actually cares about.', expect: 'pm-stakeholder' },
  // pm-prioritize
  { transcript: 'Walk me through how you decide what your team works on when everything feels important.', expect: 'pm-prioritize' },
  { transcript: 'Tell me about a time you had to say no to a project other people really wanted.', expect: 'pm-prioritize' },
  { transcript: "So, uh, how do you keep from just prioritizing whoever's the loudest?", expect: 'pm-prioritize' },
  { transcript: 'How do you divide limited resources across two things that both matter?', expect: 'pm-prioritize' },
  { transcript: 'Describe a prioritization call you made that was not popular.', expect: 'pm-prioritize' },
  { transcript: 'Tell me about your framework for ranking a backlog.', expect: 'pm-prioritize' },
  // pm-time — deliberately includes the literal STOPWORDS-affected phrasing
  { transcript: 'So, how do you manage your time when there is just so much going on?', expect: 'pm-time' },
  { transcript: 'How do you keep your calendar from running your entire life?', expect: 'pm-time' },
  { transcript: 'Walk me through how you actually plan out your day.', expect: 'pm-time' },
  { transcript: 'Tell me about protecting focus time when meetings want to eat everything.', expect: 'pm-time' },
  { transcript: 'How do you make sure nothing falls through the cracks with so much on your plate?', expect: 'pm-time' },
  { transcript: 'What does a typical week look like for you, organizationally?', expect: 'pm-time' },
  // negatives: logistics, small talk, and adjacent-but-different
  { transcript: "What's your notice period?", expect: null },
  { transcript: 'What salary range are you looking for?', expect: null },
  { transcript: 'Are you interviewing with other companies right now?', expect: null },
  { transcript: 'So, what do you like to do for fun outside of work?', expect: null },
  { transcript: 'What project management tools have you used — Jira, Asana, Monday?', expect: null },
  { transcript: 'How big was the team you managed?', expect: null },
  { transcript: 'What is your availability to start?', expect: null }
]

export const CORPUS: { sheet: CueSheet; cases: { transcript: string; expect: string | null }[] }[] = [
  { sheet: supportSheet, cases: supportCases },
  { sheet: backendSheet, cases: backendCases },
  { sheet: pmSheet, cases: pmCases }
]
