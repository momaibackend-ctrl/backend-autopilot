# ADR 001: Provider-neutral ports and adapters

Status: accepted. Core owns domain contracts and application orchestration; GitHub, Supabase, task source, LLM and secret implementations remain adapters. This keeps a new backend stack or tracker from changing the control-plane architecture.
