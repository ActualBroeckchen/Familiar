# Upcoming Features and Fixes
## Knowledge Base
- Refine Injection Structure (optimize for context caching)
- Better UI for the Tome Manager

## Session Handling
- Ingesting old sessions upon start of software
- Implementing way to do the topic thing with old logs
- Fixing elapsedTime to actually reflect time since second-to-last user message
- add equivalent for time since last session end
- Consider how to write the injection prompt for times

## Time/Heartbeat
- Schedule mechanic from Marinara Engine as reference
- Routine instead of Heartbeat
- Ways to import HEARTBEAT.md from OpenClaw and let the Familiar put their schedule together?
- Consider how to write the injection prompt for times

How do I convey the idea of a sort of timetable to the LLM? How do I make sure sudden events still get considered correctly (for example an important email arriving) without constant checking heartbeats? MarinaraEngine uses a separate agent to do the schedule thing, is that a possibility?

Perhaps ADHD resources on executive dysfunction yield ideas I can apply to the software for this.

Autonomous messaging will be vital too. Gotta figure that out somehow.

## Multiple Users
Still need to figure out an architecture that allows the LLM to instantly understand "This is my bonded user, these are support network users". Entity-core should help with the identities of surrounding users but I need to consider how to maintain the bond.

## Security
Gotta prepare Familiar for Prompt Injection attacks especially. 

## Discord Integration, WhatsApp Integration
Need to especially figure out groups. For most cases, additional users could be defined and approved by the bonded user. But for servers? That's unfeasible. Need to figure out how to sustainable get that done.

## Face
Buratino integration, but also with a face in the UI, in preparation for the graphics later.

## Bells and Whistles
Vision models, imgen models, TTS, STT. Fishaudio/Fish Speech perhaps? Ideal would be fully local.