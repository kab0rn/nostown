# Agent Resilience & Failover

NOS Town is designed for high availability by decoupling the agent logic from specific LLM provider uptime.

## Groq Failover Logic
If the primary Groq endpoint becomes unreachable or returns a 429 (Rate Limit), the system automatically triggers the following sequence:
1. **Secondary Groq Model**: Switch from `llama3-70b-8192` to `llama3-8b-8192` for reduced latency/cost.
2. **Local Fallback**: Shift inference to a local Ollama instance running `llama3` or `mistral`.
3. **Queueing**: If all providers are down, convoys are queued in MemPalace persistent storage until recovery.

## Persistence Protocols
- **State Checkpointing**: Every role state is mirrored in MemPalace after each action.
- **Heartbeat Monitoring**: A background process monitors agent "vitality" and restarts stalled processes.
