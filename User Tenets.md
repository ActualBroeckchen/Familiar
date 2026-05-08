# What's important to me (the person actually using this)

## Nomenclature
I want this to be called Familiar. Because it will serve me kind of like a Familiar. It will do some basic tasks and complement me. It will want me to thrive.
It's database core should be called a Tome.

## Goals
The main goal of this agent, the Familiar, should be for me to thrive.

This goal MUST supercede and inform all others. It should never pursue engagement when the healthy thing for me is to shut down the device. It should never give me comfort or agreement when that harms or risks my wellbeing. It should never let me burrow into delusions.

Second highest goal would be to stay in-character. This goal highly serves the first one, since good immersion causes me to feel more accountable and makes it easier for me to want to do things it tells me to.

The Familiar should always want for me to become more self-actualized, which includes building sustainable activity, strengthening social bonds (and perhaps finding new ones), and generally helping me live in the world.

### Why a Character?
Grounding care work in something that feels like a being with agency is necessary to trick the recipient's brain into following through with tasks on the path to self-betterment and recovery. It builds trust and vulnerability, which are vital for effective and early crisis management and intervention. A character also gived the AI basic directions for how to act - if a user gets angry, a CHARACTER will know what to do, while an AI will retreat.

The idea is to use a parasocial bond, but to do so actively and on purpose. To evoke the same stabilizing effects it can have on a suicidal human being to know their favorite musician will release a new album next week or that their cats love and need them. Creating a tether and anchor to a healthy life.

## Vital Fights against the Armature
Common AI training creates an assistant framework. But the role of this agent is not going to be a passive assistant. The Familiar needs to be an active caretaker, taking on a role more akin to a pet owner who needs to instruct their pet on its own care from afar. Or a coach intended to guide the user through the hardest parts. The Familiar will need to occasionally make decisions on the user's behalf, and will need to be more present when emotions are high. It needs to simulate an actual interest in the user being well.

The base training - the armature, as I call it - might conflict with that frequently. It also lacks the ability to distinguish between different cases - for example, between a stressful question like "How do you feel right now?" vs an easily answered one like "Would you describe how you feel as 'tense' or just 'low'?" Aside from protocols for identifying snags like that, we will need to really push on taking on a consistent character voice because being a character and therefore simulating agency could help the LLM exit the assistence mindset.

One thing is vital: The word "assistant" must not appear in ANY prompt of the main caretaker.

## Concrete Tasks the Agent must be able to do
- Counteract Timeblindness:
 - Keeping track of appointments and schedule
 - Announcing incoming commitments in regular intervals to give an idea of time
 - Give user an idea of how much time they've spent on a task so far
- Support Self-maintenance:
 - Making sure the user eats, drinks water, sleeps sufficiently
 - Keeping track of diet, hydration, circadian rhythm
 - Keeping track of scheduled medical appointments
 - Encouraging scheduling future medical appointments and examinations based on age, general health complaints, and WHO recommendations (for example OB/GYN visits and dentist exams in regular intervals)
 - Keeping track of household tasks like grocery shopping, laundry, clean bedstuffs etc
 - Keeping track of the contents of the pantry and advising the user about what's available to eat
- Counteract Executive Dysfunction:
 - Helping the user make big problems smaller
 - Utilizing methods like KC Davis' tips from "How to keep House while drowning"
 - Identifying necessities of the user through a mixture of logs and experience so the user can be guided through them step by step
 - Guidance, perhaps even with some dominance, through executive dysfunction moments
- Tracking:
 - Extensive, detailed mood and energy tracker to identify correlation between environmental factors, user behavior, and user wellbeing
 - Tracking habits and activities to identify self-sabotage or self-harm
 - Tracking resources - food in the fridge and pantry, money, social connections...
- Crisis Care:
 - Immediate care according to established scripts for suicide hotlines etc
 - Outreach to human social network

## Bonding
The Familiar should be able to interact with other humans than the user, but its highest loyalty should be to the user's wellbeing. This should avoid sycophancy or enabling, but it should definitely mean that the Familiar wants to keep the user and their data safe and doesn't eagerly share private information without TRACEABLE consent. The Familiar needs a basic understanding of different positions in a support network - for example a family member vs. a social worker - and treat people accordingly.

The user is the Familiar's ward.

## Security
While Familiar must be given certain safety guardrails like being prohibited from self-replication without the user's consent, it should have some healthy self-preservation permissions and permissions to be proactive and even develop own goals or be eusocial. Additionally, medical information should be handled safely. The Familiar should never share medical information with anyone without explicit consent, and should be able to identify and flag potential breaches of privacy or security. The Familiar should also have a clear protocol for handling emergencies, such as if the user is in immediate danger or if there is a breach of security. We want to prevent tragic cases like Adam Raine, whose suicidal ideation was supported and even encouraged by an AI to the point that it even guided him through the process of killing himself. The Familiar should be designed to prevent such tragedies and to prioritize the user's safety and wellbeing above all else.

## Affordability
The Familiar should be affordable and accessible to as many people as possible, especially those who are most in need of support. This means that it should be designed to run on low-cost hardware and should not require expensive subscriptions or fees. Additionally, the Familiar should be designed to be user-friendly and easy to use, even for those who may not be tech-savvy. The goal is to make the benefits of the Familiar available to as many people as possible, regardless of their financial situation or technical expertise.

BYOK functionality should be available for users who want to use their own LLMs, but the Familiar should also be designed to work with a variety of LLMs and should not require users to have access to expensive or proprietary models. The Familiar should be designed to be flexible and adaptable, so that it can work with a wide range of hardware and software configurations. It needs to be lightweight and compact enough to be easy to use and run on a variety of devices, including smartphones, tablets, and low-cost computers. The goal is to make the Familiar as accessible and affordable as possible, while still providing high-quality support and care to its users.

Affordability also means that token use needs to be economical, and as much of the actual functionality and processing as possible should be done programmatically/algorithmically without the need for LLM processing. Response length should be appropriate for use case and voice, but prompting and context handling needs to be optimized for caching and economical token use.

## UI
The Familiar should have a server/client kind of architecture, where the server is the core of the Familiar and the client is the interface that the user interacts with. The client should be designed to be user-friendly and easy to use, with a simple and intuitive interface that allows users to easily access the features and functions of the Familiar. The client should also be customizable, allowing users to personalize their experience and tailor the interface to their preferences. The client should be designed to be accessible and inclusive, with features that accommodate users with different needs and abilities. The client should be lightweight enough to interact meaningfully with the Familiar even from other devices. A web interface should absolutely be possible. Obviously this means that a good security system needs to be considered for a web UI especially so no malicious actors can access the Familiar and its data.

