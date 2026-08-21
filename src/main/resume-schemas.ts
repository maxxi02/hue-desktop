import { COMPETENCIES } from '../shared/profile.ts'

/**
 * JSON Schemas for the structured-output calls.
 *
 * Two rules the API enforces and one it does not, all of which shape what is
 * written here:
 *
 *  - Every object needs `additionalProperties: false`, and every property must
 *    appear in `required`. Optionality is expressed as a nullable type, not as
 *    an absent key — which suits this pipeline exactly, because "absent" and
 *    "unknown" must never be confused (Profile & Ingest).
 *  - `minLength` / `maxItems` and friends are **not** enforced. Counts and
 *    lengths are therefore bounded in `pipeline.ts` rather than asserted here.
 */

const nullableString = { type: ['string', 'null'] } as const
const stringArray = { type: 'array', items: { type: 'string' } } as const

export const PROFILE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['identity', 'roles', 'education', 'skills', 'metrics'],
  properties: {
    identity: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'headline', 'location', 'email', 'links'],
      properties: {
        name: nullableString,
        headline: nullableString,
        location: nullableString,
        email: nullableString,
        links: stringArray
      }
    },
    roles: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'company', 'title', 'start', 'end', 'current', 'stack', 'summary'],
        properties: {
          // The model assigns ids so the story-mining pass can reference roles
          // by name rather than by array position, which drifts.
          id: { type: 'string' },
          company: { type: 'string' },
          title: { type: 'string' },
          start: nullableString,
          end: nullableString,
          current: { type: 'boolean' },
          stack: stringArray,
          summary: nullableString
        }
      }
    },
    education: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['institution', 'credential', 'field', 'end'],
        properties: {
          institution: { type: 'string' },
          credential: nullableString,
          field: nullableString,
          end: nullableString
        }
      }
    },
    skills: stringArray,
    metrics: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['roleId', 'value', 'claim'],
        properties: {
          roleId: nullableString,
          value: { type: 'string' },
          claim: { type: 'string' }
        }
      }
    }
  }
}

export const STORIES_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['stories'],
  properties: {
    stories: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'id',
          'roleId',
          'competencies',
          'situation',
          'task',
          'action',
          'result',
          'metrics'
        ],
        properties: {
          // Slug-like and human-meaningful: this id is the grounding receipt
          // the live UI shows, so "conflict-manager-roadmap" beats "s7".
          id: { type: 'string' },
          roleId: nullableString,
          competencies: { type: 'array', items: { type: 'string', enum: [...COMPETENCIES] } },
          situation: { type: 'string' },
          task: { type: 'string' },
          action: { type: 'string' },
          result: { type: 'string' },
          metrics: stringArray
        }
      }
    }
  }
}

export const GAP_QUESTIONS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['questions'],
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['competency', 'question'],
        properties: {
          competency: { type: 'string', enum: [...COMPETENCIES] },
          question: { type: 'string' }
        }
      }
    }
  }
}

/**
 * Technical probes, one per target the pipeline picked.
 *
 * `targetId` rather than a free-text subject: the pipeline chose which role and
 * which technologies to ask about, and it needs to map each returned question
 * back to that choice to anchor the gap. Letting the model name its own subject
 * would let it drift onto a technology the resume never listed, which is the
 * exact failure the rest of this pipeline is built to prevent.
 */
export const TECH_QUESTIONS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['questions'],
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['targetId', 'question'],
        properties: {
          targetId: { type: 'string' },
          question: { type: 'string' }
        }
      }
    }
  }
}

/** One spoken answer folded back into the bank as a STAR entry. */
export const GAP_ANSWER_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['usable', 'reason', 'story'],
  properties: {
    // The user may answer "I don't have one". Recording that honestly is the
    // whole point — a fabricated story here would defeat the gap scan.
    usable: { type: 'boolean' },
    reason: nullableString,
    story: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: [
        'id',
        'roleId',
        'competencies',
        'situation',
        'task',
        'action',
        'result',
        'metrics'
      ],
      properties: {
        id: { type: 'string' },
        roleId: nullableString,
        competencies: { type: 'array', items: { type: 'string', enum: [...COMPETENCIES] } },
        situation: { type: 'string' },
        task: { type: 'string' },
        action: { type: 'string' },
        result: { type: 'string' },
        metrics: stringArray
      }
    }
  }
}

export const JD_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['likelyQuestions', 'uncoveredRequirements'],
  properties: {
    likelyQuestions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['question', 'storyId', 'competency'],
        properties: {
          question: { type: 'string' },
          // null is the useful answer here: it names the weak flank.
          storyId: nullableString,
          competency: { type: 'string', enum: [...COMPETENCIES] }
        }
      }
    },
    uncoveredRequirements: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['requirement', 'note'],
        properties: {
          requirement: { type: 'string' },
          note: { type: 'string' }
        }
      }
    }
  }
}
