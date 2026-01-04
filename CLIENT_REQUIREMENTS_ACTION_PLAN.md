# Client Requirements - Action Plan

## Summary of Client Feedback

The client has provided detailed feedback about improving the diagnostic system. Here's what needs to be addressed:

### Key Issues Identified

1. **Current System Over-Emphasizes Log-Ins**
   - The AI is putting too much weight on login data instead of life experience/results
   - Need to shift focus to structure, vortex settings, avoidance behavior, and progress

2. **Question Quality Needs Improvement**
   - Custom AI link had better, more direct questions
   - Questions should focus on:
     - Finding structure
     - Identifying vortex settings
     - Mapping avoidance behavior
     - Assessing progress/results
     - Life experience over metrics

3. **Discovery System Missing**
   - Need three main pillars:
     - **Alignment** - what they want to create
     - **Freedom** - energetic and strategic
     - **Prosperity** - integration of them all
   - All discoveries should link to Euphoriam formula

4. **Metrics Display After Diagnostic**
   - Metrics should appear after diagnostic is done
   - Should show the bottleneck to work on
   - Need visual/metrics dashboard

5. **Coach Access**
   - Coaches need to see client data in next phase
   - Need login/data access for coaches

---

## Action Items

### 1. Improve Prompt System to Focus on Structure/Vortex/Avoidance

**Current State:**
- `buildFreeformIntakePrompt` uses generic questions
- First question is about "Desired Reality" which is good, but subsequent questions may not be structured enough
- System relies heavily on Kajabi metrics (sign-ins, revenue) for calculations

**Required Changes:**
- Update prompt instructions to emphasize:
  - Structure detection questions
  - Vortex settings identification
  - Avoidance behavior mapping
  - Progress/results assessment (not just log-ins)
  - Life experience questions
- Questions should reveal:
  - Identity structure
  - 3D vortex codes
  - Gravity patterns
  - Avoidance strategies
  - Signal coherence indicators

**Files to Modify:**
- `src/helpers/euphoriamChatbot.js` - `buildFreeformIntakePrompt()` function
- `src/helpers/euphoriamChatbot.js` - `EUPHORIAM_FREEFORM_INTAKE_SYSTEM_PROMPT`
- `src/controllers/diagnosticController.js` - `chatbotDiagnosticFreeform()` function

**Implementation Notes:**
- The prompt should guide AI to ask questions that directly map to:
  - Structure Type Detection
  - Vortex Settings
  - Avoidance Behavior Mapping
  - 3D Code (Gravity) analysis
  - Progress indicators (life results, not just platform engagement)

---

### 2. Implement Discovery System with Three Pillars

**Required Features:**

#### Pillar 1: Alignment (What They Want to Create)
- Questions about desired reality, authentic genius, what they want to create
- Links to first half of Euphoriam formula (alignment/authentic genius)

#### Pillar 2: Freedom (Energetic & Strategic)
- Questions about energetic blocks, strategic constraints
- Freedom to act, move, create

#### Pillar 3: Prosperity (Integration)
- Questions about integration of alignment + freedom
- How they're bringing it all together
- Results and manifestations

**All Pillars Must:**
- Link to Euphoriam formula
- Connect to structure, vortex, avoidance
- Feed into metrics calculation
- Show in diagnostic report

**Database Changes Needed:**
- May need to add `discoveryType` field to `Discovery` model:
  - `alignment`
  - `freedom`
  - `prosperity`
  - `integrated` (all three)

**Files to Create/Modify:**
- `src/models/discoveryModel.js` - Add discovery type
- `src/controllers/diagnosticController.js` - Update discovery logic
- `src/helpers/euphoriamChatbot.js` - Add discovery prompt builders for each pillar

---

### 3. Metrics Display & Bottleneck Identification

**Current State:**
- Metrics are calculated in `computeDiagnosticMetrics()`
- Metrics stored in diagnostic `data.metrics`
- No dedicated endpoint to display metrics with bottleneck

**Required Features:**
- API endpoint to get metrics for a user/diagnostic
- Identify bottleneck (lowest metric or highest gravity)
- Visual representation (could be frontend, but API should provide data)
- Show after diagnostic completion

**Metrics to Display:**
- QGC Activation
- Consciousness Level
- Gravity
- Signal Coherence
- Signal Output
- Engagement Score
- Learning Score
- Commitment Score

**Bottleneck Logic:**
- Identify lowest metric (or highest gravity)
- Provide context on what that means
- Suggest focus areas

**Files to Create/Modify:**
- `src/controllers/diagnosticController.js` - Add `getMetrics()` function
- `src/routes/diagnosticRoutes.js` - Add metrics endpoint
- `src/controllers/diagnosticController.js` - Add bottleneck calculation logic

**New Endpoint:**
```
GET /diagnostics/:id/metrics
Response: {
  metrics: {...},
  bottleneck: {
    metric: "gravity",
    value: 75,
    interpretation: "...",
    focusAreas: [...]
  }
}
```

---

### 4. Coach Access System

**Required Features:**
- Coaches can log in and view client data
- See all diagnostics for their clients
- View metrics and bottlenecks
- Access discovery records
- See progress over time

**Implementation Options:**

#### Option A: Extend Admin System
- Add "coach" role alongside "admin"
- Coaches see only their assigned clients
- Use existing admin routes with role filtering

#### Option B: Separate Coach System
- New `Coach` model
- Coach-Client relationship table
- Separate coach routes

**Recommended: Option A (Extend Admin)**
- Reuse existing infrastructure
- Add role-based filtering
- Simpler to implement

**Database Changes:**
- Add `coachId` to `User` model (optional, for client-coach relationship)
- Or create `CoachClient` junction table
- Add "coach" to role enum

**Files to Create/Modify:**
- `src/models/userModel.js` - Add coach relationship
- `src/middleware/requireRole.js` - Support "coach" role
- `src/controllers/adminController.js` - Add coach-specific filtering
- `src/routes/adminRoutes.js` - Add coach routes (or extend existing)

**New Endpoints:**
```
GET /coach/clients - Get all assigned clients
GET /coach/clients/:clientId/diagnostics - Get client diagnostics
GET /coach/clients/:clientId/metrics - Get client metrics
GET /coach/clients/:clientId/discoveries - Get client discoveries
```

---

### 5. Update Formula Understanding in Prompts

**Current Understanding:**
- Formula has two halves:
  - **Half 1:** Alignment/Authentic Genius
  - **Half 2:** Resistance/3D Vortex Codes → Gravity, Distortion, Avoidance

**Required Changes:**
- Update system prompts to reflect this understanding
- Questions should map to both halves
- Diagnostic should clearly show both sides
- Metrics should reflect both alignment and resistance

**Files to Modify:**
- `src/helpers/euphoriamChatbot.js` - `EUPHORIAM_V3_SYSTEM_PROMPT`
- `src/helpers/euphoriamChatbot.js` - `buildFreeformIntakePrompt()`
- `src/helpers/euphoriamChatbot.js` - `buildFinalReportPrompt()`

---

## Priority Order

Based on client feedback, suggested implementation order:

1. **High Priority:**
   - ✅ Improve prompt system (structure/vortex/avoidance focus)
   - ✅ Update formula understanding in prompts
   - ✅ Metrics display & bottleneck identification

2. **Medium Priority:**
   - Discovery system with three pillars
   - Coach access system

3. **Future Enhancements:**
   - Advanced metrics visualization
   - Progress tracking over time
   - Coach-client communication features

---

## Questions for Client

Before implementing, we should clarify:

1. **Prompt Questions:**
   - Do you have the exact questions from the custom AI link that worked well?
   - Should we use those as a template?

2. **Discovery System:**
   - Are discoveries separate from diagnostics, or integrated?
   - Should each discovery session focus on one pillar, or all three?
   - How do discoveries feed back into the diagnostic?

3. **Coach Access:**
   - How are coaches assigned to clients? (Manual assignment? Automatic?)
   - What level of access do coaches need? (Read-only? Can they add notes?)

4. **Metrics Display:**
   - Where should metrics appear? (In the app? Email? PDF?)
   - What format for bottleneck display? (Text? Visual gauge? Both?)

5. **Formula Integration:**
   - Should the diagnostic report explicitly show the two halves?
   - How should questions map to each half?

---

## Next Steps

1. **Immediate:**
   - Remove `DEEP_INTAKE_QUESTIONS` (✅ Done)
   - Review and update prompt system to focus on structure/vortex/avoidance
   - Add metrics endpoint with bottleneck calculation

2. **Short-term:**
   - Implement discovery system with three pillars
   - Add coach role and access system

3. **Coordination:**
   - Schedule zoom call to align on implementation details
   - Get examples of good questions from custom AI link
   - Confirm discovery system architecture

---

## Technical Notes

### Current Metrics Calculation
```javascript
// Currently in computeDiagnosticMetrics()
engagementScore = signInCount * 6.25  // Too focused on log-ins!
learningScore = assessmentCompletion
commitmentScore = revenue/10 + products*8
signalOutput = 0.5*engagement + 0.3*learning + 0.2*commitment
```

**Issue:** Too much weight on engagement (log-ins). Need to incorporate:
- Life experience indicators
- Progress/results from intake answers
- Structure/vortex/avoidance patterns from questions

### Suggested Approach
- Reduce weight on `engagementScore` (log-ins)
- Add new metrics from intake answers:
  - Structure clarity score
  - Vortex awareness score
  - Avoidance pattern score
  - Progress indicators
- Use these in signalOutput calculation

---

## Files Summary

### Files to Modify:
1. `src/helpers/euphoriamChatbot.js` - Prompt improvements
2. `src/controllers/diagnosticController.js` - Metrics endpoint, discovery logic
3. `src/models/discoveryModel.js` - Add discovery type
4. `src/models/userModel.js` - Add coach relationship
5. `src/middleware/requireRole.js` - Support coach role
6. `src/routes/diagnosticRoutes.js` - Add metrics endpoint
7. `src/routes/adminRoutes.js` - Add coach routes

### Files to Create:
1. `src/controllers/coachController.js` - Coach-specific logic (if separate)
2. `src/routes/coachRoutes.js` - Coach routes (if separate)

---

## Implementation Checklist

- [ ] Remove DEEP_INTAKE_QUESTIONS (✅ Done)
- [ ] Update prompt system for structure/vortex/avoidance focus
- [ ] Add metrics endpoint with bottleneck
- [ ] Implement discovery three-pillar system
- [ ] Add coach role and access
- [ ] Update formula understanding in prompts
- [ ] Test with sample data
- [ ] Get client feedback
- [ ] Iterate based on feedback






