---
'@composio/json-schema-to-zod': patch
---

Accept a value that satisfies an object's own `properties` together with a sibling `oneOf`, `anyOf` or `allOf` branch that declares further properties. The parent and the branch used to reject each other's keys, so no input was valid. Unknown keys are still rejected, now against the union of the keys the parent and its branches declare.
