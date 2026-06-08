const {
  isGoalsComplete,
  computeOnboardingStatus,
  upsertDomainMap,
  setActiveDomain,
  setPrimaryDomain,
  deactivateDomain,
  emptyStage1State,
} = require("../helpers/stage1State");
const { getTier, getTierLimits, canActivateDomain } = require("../helpers/membershipDomains");
const { isValidDomain, normalizeDomain } = require("../constants/domains");

describe("domains constants", () => {
  test("validates known domains", () => {
    expect(isValidDomain("income")).toBe(true);
    expect(isValidDomain("INVALID")).toBe(false);
    expect(normalizeDomain("Income")).toBe("income");
  });
});

describe("membershipDomains", () => {
  test("bronze tier from membership flags", () => {
    expect(
      getTier({ membership: { isCreatorClubBronze: true, isCreatorClub: true } }),
    ).toBe("bronze");
  });

  test("silver tier", () => {
    expect(getTier({ membership: { isCreatorClubSilver: true } })).toBe("silver");
  });

  test("accelerate tier from membership flag or product title", () => {
    expect(getTier({ membership: { isCreatorClubAccelerate: true } })).toBe("accelerate");
    expect(
      getTier({
        membership: { products: [{ title: "Euphoriam Accelerate" }] },
      }),
    ).toBe("accelerate");
  });

  test("canActivateDomain respects limit", () => {
    const user = { membership: { isCreatorClubBronze: true } };
    expect(canActivateDomain(user, 0, false)).toBe(true);
    expect(canActivateDomain(user, 1, false)).toBe(false);
    expect(canActivateDomain(user, 1, true)).toBe(true);
  });
});

describe("stage1State", () => {
  const fullGoal = {
    domain: "income",
    goal_title: "Launch funnel",
    desired_outcome: "25 sales",
    target_date: "90 days",
    proof_of_success: "Stripe dashboard",
    milestones: { day_7: "a", day_30: "b", day_90: "c" },
    today_visible_action: "Email Lee",
  };

  test("isGoalsComplete requires all fields", () => {
    expect(isGoalsComplete(fullGoal)).toBe(true);
    expect(isGoalsComplete({ ...fullGoal, goal_title: "" })).toBe(false);
  });

  test("onboarding none → goals_complete → resistance", () => {
    let stage1 = emptyStage1State();
    expect(computeOnboardingStatus(stage1)).toBe("none");

    stage1 = upsertDomainMap(stage1, "income", fullGoal);
    expect(computeOnboardingStatus(stage1)).toBe("goals_complete");

    stage1 = { ...stage1, map_resistance_in_progress: true };
    expect(computeOnboardingStatus(stage1)).toBe("resistance_in_progress");
  });

  test("setActiveDomain enforces goals_complete", () => {
    let stage1 = emptyStage1State();
    stage1 = upsertDomainMap(stage1, "income", { domain: "income", goal_title: "x" });
    const result = setActiveDomain(stage1, "income", getTierLimits("bronze"));
    expect(result.ok).toBe(false);
  });

  test("setActiveDomain swaps single active for bronze", () => {
    let stage1 = upsertDomainMap(emptyStage1State(), "income", fullGoal);
    stage1 = upsertDomainMap(stage1, "health", { ...fullGoal, domain: "health", goal_title: "Health goal" });
    const r1 = setActiveDomain(stage1, "income", getTierLimits("bronze"));
    expect(r1.ok).toBe(true);
    const r2 = setActiveDomain(r1.stage1, "health", getTierLimits("bronze"));
    expect(r2.ok).toBe(true);
    expect(r2.stage1.active_domains).toEqual(["health"]);
    expect(r2.stage1.domain_maps.find((m) => m.domain === "income").status).toBe("stored");
  });

  test("silver second activation keeps primary unless set_primary", () => {
    const alignmentGoal = { ...fullGoal, domain: "alignment", goal_title: "Align daily" };
    let stage1 = upsertDomainMap(emptyStage1State(), "income", fullGoal);
    stage1 = upsertDomainMap(stage1, "alignment", alignmentGoal);
    const r1 = setActiveDomain(stage1, "income", getTierLimits("silver"), { setPrimary: true });
    expect(r1.ok).toBe(true);
    expect(r1.stage1.primary_domain).toBe("income");

    const r2 = setActiveDomain(r1.stage1, "alignment", getTierLimits("silver"), {
      setPrimary: false,
    });
    expect(r2.ok).toBe(true);
    expect(r2.stage1.primary_domain).toBe("income");
    expect(r2.stage1.active_domains).toEqual(["income", "alignment"]);
  });

  test("setPrimaryDomain reorders active_domains", () => {
    const alignmentGoal = { ...fullGoal, domain: "alignment", goal_title: "Align daily" };
    let stage1 = upsertDomainMap(emptyStage1State(), "income", fullGoal);
    stage1 = upsertDomainMap(stage1, "alignment", alignmentGoal);
    stage1 = setActiveDomain(stage1, "income", getTierLimits("silver")).stage1;
    stage1 = setActiveDomain(stage1, "alignment", getTierLimits("silver"), {
      setPrimary: false,
    }).stage1;

    const r = setPrimaryDomain(stage1, "alignment");
    expect(r.ok).toBe(true);
    expect(r.stage1.primary_domain).toBe("alignment");
    expect(r.stage1.active_domains[0]).toBe("alignment");
  });

  test("deactivateDomain clears primary and promotes next active", () => {
    const alignmentGoal = { ...fullGoal, domain: "alignment", goal_title: "Align daily" };
    let stage1 = upsertDomainMap(emptyStage1State(), "income", fullGoal);
    stage1 = upsertDomainMap(stage1, "alignment", alignmentGoal);
    stage1 = setActiveDomain(stage1, "income", getTierLimits("silver")).stage1;
    stage1 = setActiveDomain(stage1, "alignment", getTierLimits("silver"), {
      setPrimary: false,
    }).stage1;

    const r = deactivateDomain(stage1, "income");
    expect(r.ok).toBe(true);
    expect(r.stage1.primary_domain).toBe("alignment");
    expect(r.stage1.active_domains).toEqual(["alignment"]);
    expect(r.stage1.domain_maps.find((m) => m.domain === "income").status).toBe("stored");
  });
});
