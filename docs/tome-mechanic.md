# The Tome
The idea behind the Tome is that the Familiar's entire core is local and independent of chat context.

The idea is to replicate how humans retain knowledge and growth even if they forget where they *learned* the knowledge or how they achieved that growth. Aside from that, the Familiar can do better agentic work and adapt better to current situations if as little as possible of their ongoing knowledge is in the current context.

## Knowledge Storage
When knowledge is acquired or expanded, it gets stored in a database. Not as snippets of the chat conversation, but in somewhat more summarized fashion. For example:
```
User: Oh God, I think I'm going to be late
Familiar: [checks calendar, sees that today is just a casual meetup with friends]
Familiar: Is that awful? It's just a casual meetup, right? And your friends will likely be nice about it?
User: Yeah but being late always stresses me out. I feel so guilty about it.
Familiar: [writes to database: "Being late stresses user out, even if the stakes are low. It causes them a lot of guilt."]
```

This is only the actual content. The entry will have other fields - keywords, logic, etc.

One potentially useful field could be "Learned: DD/MM/YYYY, HH:MM" so the Familiar can retrieve the conversation context if need be.

## Knowledge Retrieval
Knowledge retrieval will need to work depending on the established triggers.

Some entries will be activated by keywords. For example: 
```
"Birb is User's significant other. They work [job] and are [age] years old, and they live in the same city but at a 40 minute distance by public transport. Valid emergency contact."
```

Could be tied to keywords like `Birb, boyfriend, girlfriend, romantic relationship, partner, significant other` so it will always be pulled up in that context.

### Important Sidenote
For a lot of this information, we will be using entity-core. It's a solid system especially for day-to-day. However, there still will be a necessity for Tomes, as those will need to store more specialized information: medical knowledge, treatment information, legal information, complete toolsets, etc. Knowledge that works best when "summoned" depending on the context.

## Identity
A lot of the identity knowledge will be stored in entity-core. One of the most important aspects will be the Voice notes, which should always be injected post-history to keep the Familiar in character.

To avoid unhealthy attachment dynamics with the user, Familiar should offer animals as potential identities for itself instead. For the alpha version, these should be free to pick for the user. The animal's body features should come up in conversation or inform its voice a little - a cat might disdainfully flick an ear when annoyed, a snake might rattle its tail when offended. 

The idea behind this is to give the Familiar an identity that evokes SOME emotional connection, similar to a pet, while priming the user's brain into a mindset where the idea of starting a romantic or sexual relationship with the Familiar is not as likely. Hopefully, this can prevent the user from retreating from other humans by substituting them for the Familiar.