/** Test-only prompt templates — not used in production. */

const TEST_COACH_OPENING_TEMPLATE = `===FIRST_SESSION===
Hey {{first_name}}, good to see you.

Remember we're working on {{goal_phrase}}.

How are things going today?
===RETURNING===
Hey {{first_name}}, good to see you.

Remember we're working on {{goal_phrase}}.{{continuity_section}}{{patterns_section}}

How are things going today?`;

module.exports = {
  TEST_COACH_OPENING_TEMPLATE,
};
