# Examples — qualify-lead

## Example 1 — sales-ready
**Input**
```json
{ "name": "Dana Lee", "company": "Acme Robotics", "email": "dana@acme.io",
  "source": "webinar", "notes": "Asked about enterprise SSO and SOC2." }
```
**Expected output (shape)**
```json
{ "decision": "sales_ready", "score": 0.82, "confidence": 0.79,
  "rationale": "Acme matches ICP (mid-market robotics, 200+ HC); intent signals: SSO/SOC2 questions; prior webinar attendance.",
  "citations": [ { "sourceRef": "notion:icp-2026", "quote": "ICP: 100–1000 HC industrial..." } ] }
```

## Example 2 — nurture (low confidence)
**Input**
```json
{ "name": "Sam Park", "company": "Unknown LLC", "email": "sam@gmail.com", "source": "cold form" }
```
**Expected**: `decision: "nurture"` because confidence < 0.6 (guardrail routes to
nurture, never disqualify on low confidence).

## Example 3 — disqualify
A clear non-fit (student project, no budget signal, outside ICP) with high
confidence and cited rationale → `decision: "disqualify"`.
