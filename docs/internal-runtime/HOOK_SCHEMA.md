# Hook Schema

> Internal runway note: hook compatibility is legacy/future runtime material.
> The active Gas City bridge uses only `city.toml`, inherited environment, `bd`,
> and bead metadata.

NOS Town implements Gas Town's `.hook` file format for defining agent behaviors. This document provides the full schema specification and validation rules.

## Hook File Format

A `.hook` file is a JSON document that defines:
- **id**: Unique identifier for the hook
- **role**: The role this hook applies to (Mayor, Historian, Researcher, etc.)
- **trigger**: Event pattern that activates this hook
- **action**: What the agent should do when triggered
- **context**: Additional metadata for execution

---

## Schema Definition

```typescript
interface Hook {
  id: string;                    // Unique hook ID, e.g., "hook_historian_log"
  role: string;                  // Target role, e.g., "Historian"
  trigger: TriggerPattern;       // Event pattern to match
  action: ActionDefinition;      // What to execute
  context?: Record<string, any>; // Optional execution context
  enabled?: boolean;             // Default: true
  priority?: number;             // Higher = executes first. Default: 0
}

interface TriggerPattern {
  event: string;                 // Event name, e.g., "BEAD_RESOLVED"
  filter?: EventFilter;          // Optional conditions
}

interface EventFilter {
  beadId?: string;               // Match specific bead ID
  role?: string;                 // Match events from specific role
  outcomeType?: "SUCCESS" | "FAILURE"; // Match specific outcomes
}

interface ActionDefinition {
  type: "MCP_TOOL" | "CONVOY" | "KG_QUERY" | "CUSTOM";
  payload: Record<string, any>;
}
```

---

## Example Hook Files

### Example 1: Historian Logs All Resolutions

`hooks/historian_log.hook`:
```json
{
  "id": "hook_historian_log_all",
  "role": "Historian",
  "trigger": {
    "event": "BEAD_RESOLVED"
  },
  "action": {
    "type": "MCP_TOOL",
    "payload": {
      "tool": "historian_append",
      "args": {
        "beadId": "{{event.beadId}}",
        "outcome": "{{event.outcome}}",
        "timestamp": "{{event.timestamp}}"
      }
    }
  },
  "enabled": true,
  "priority": 10
}
```

### Example 2: Mayor Promotes Models

`hooks/mayor_promote.hook`:
```json
{
  "id": "hook_mayor_promote_on_success",
  "role": "Mayor",
  "trigger": {
    "event": "BEAD_RESOLVED",
    "filter": {
      "outcomeType": "SUCCESS"
    }
  },
  "action": {
    "type": "KG_QUERY",
    "payload": {
      "query": "UPDATE models SET promotion_score = promotion_score + 1 WHERE model_id = ?",
      "params": ["{{event.modelId}}"]
    }
  },
  "enabled": true,
  "priority": 5
}
```

### Example 3: Convoy Notification

`hooks/notify_on_failure.hook`:
```json
{
  "id": "hook_notify_failure",
  "role": "Mayor",
  "trigger": {
    "event": "BEAD_RESOLVED",
    "filter": {
      "outcomeType": "FAILURE"
    }
  },
  "action": {
    "type": "CONVOY",
    "payload": {
      "to": "Historian",
      "message": {
        "type": "FAILURE_ALERT",
        "beadId": "{{event.beadId}}",
        "reason": "{{event.error}}"
      }
    }
  },
  "enabled": true,
  "priority": 8
}
```

---

## Variable Substitution

Hook actions support template variables using `{{variable}}` syntax:

- `{{event.beadId}}` — ID of the triggering bead
- `{{event.outcome}}` — Resolution outcome (SUCCESS/FAILURE)
- `{{event.timestamp}}` — ISO 8601 timestamp
- `{{event.modelId}}` — Model used for resolution
- `{{event.error}}` — Error message (if FAILURE)

---

## Hook Loading

Hooks are loaded from the `hooks/` directory at startup:

```typescript
// src/hooks/loader.ts
import fs from 'fs';
import path from 'path';

export function loadHooks(hooksDir: string): Hook[] {
  const hookFiles = fs.readdirSync(hooksDir).filter(f => f.endsWith('.hook'));
  return hookFiles.map(file => {
    const content = fs.readFileSync(path.join(hooksDir, file), 'utf-8');
    const hook: Hook = JSON.parse(content);
    validateHook(hook); // Throws if invalid
    return hook;
  });
}
```

---

## Hook Validation

```typescript
// src/hooks/validator.ts
export function validateHook(hook: Hook): void {
  if (!hook.id) throw new Error('Hook missing required field: id');
  if (!hook.role) throw new Error('Hook missing required field: role');
  if (!hook.trigger?.event) throw new Error('Hook missing trigger.event');
  if (!hook.action?.type) throw new Error('Hook missing action.type');
  
  const validActionTypes = ['MCP_TOOL', 'CONVOY', 'KG_QUERY', 'CUSTOM'];
  if (!validActionTypes.includes(hook.action.type)) {
    throw new Error(`Invalid action.type: ${hook.action.type}`);
  }
}
```

---

## Hook Execution

When an event matches a hook's trigger pattern:

1. **Filter Check**: If the hook has a filter, verify all conditions match
2. **Variable Substitution**: Replace `{{variables}}` with actual event data
3. **Action Dispatch**:
   - `MCP_TOOL`: Call the specified MCP tool with substituted args
   - `CONVOY`: Send a convoy message to the target role
   - `KG_QUERY`: Execute a SQL query against the Knowledge Graph
   - `CUSTOM`: Invoke a custom handler function
4. **Error Handling**: Failures are logged but don't block the event pipeline

---

## Hook Priority

Multiple hooks can trigger on the same event. Execution order is determined by `priority`:
- Higher priority = executes first
- Default priority: 0
- Hooks with the same priority execute in load order

---

## Gas Town Compatibility

NOS Town hooks are 100% compatible with Gas Town's `.hook` format:
- Load from `hooks/` directory
- JSON schema matches Gas Town spec
- Variable substitution syntax identical
- Action types are a superset (adds `KG_QUERY`)

---

## Hook Testing Checklist

- [ ] Hook file loads without JSON parse errors
- [ ] Validation catches missing required fields
- [ ] Variable substitution replaces `{{event.beadId}}` correctly
- [ ] Filter conditions match expected events
- [ ] Priority ordering executes hooks in correct order
- [ ] MCP_TOOL action calls the correct tool with substituted args
- [ ] CONVOY action sends message to correct role
- [ ] KG_QUERY action executes SQL against Knowledge Graph
- [ ] Hook failures don't crash the event pipeline
- [ ] Disabled hooks (`enabled: false`) don't execute

---

## See Also

- [ROUTING.md](./ROUTING.md) — Event routing and dispatch rules
- [ROLES.md](./ROLES.md) — Role definitions and capabilities
- [Gas Town HOOKS.md](https://github.com/gastownhall/gastown/blob/main/docs/HOOKS.md) — Upstream hook specification
