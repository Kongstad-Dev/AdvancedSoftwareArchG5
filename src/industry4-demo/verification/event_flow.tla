----------------------------- MODULE event_flow -----------------------------
EXTENDS Naturals, Sequences

CONSTANTS Sensors, Factories

VARIABLES workflowStarted, sensorHealth, failureAlerts

Init ==
  /\ workflowStarted = << >>
  /\ sensorHealth = << >>
  /\ failureAlerts = << >>

WorkflowEvent(factory, workflow) ==
  workflowStarted' = Append(workflowStarted, [factory |-> factory, workflow |-> workflow])

HealthEvent(sensor, anomaly) ==
  sensorHealth' = Append(sensorHealth, [sensor |-> sensor, anomaly |-> anomaly])

FailureAlert(sensor) ==
  failureAlerts' = Append(failureAlerts, sensor)

Next ==
  \E f \in Factories, w \in {"bottling"} :
    /\ WorkflowEvent(f, w)
    /\ UNCHANGED << sensorHealth, failureAlerts >>
  \/ \E s \in Sensors, a \in BOOLEAN :
    /\ HealthEvent(s, a)
    /\ UNCHANGED << workflowStarted, failureAlerts >>
  \/ \E s \in Sensors :
    /\ FailureAlert(s)
    /\ UNCHANGED << workflowStarted, sensorHealth >>

AvailabilityInvariant ==
  \A i \in 1..Len(failureAlerts) :
    \E j \in 1..Len(sensorHealth) :
      sensorHealth[j].sensor = failureAlerts[i] /\ sensorHealth[j].anomaly = TRUE

Spec == Init /\ [][Next]_<<workflowStarted, sensorHealth, failureAlerts>>

THEOREM Spec => []AvailabilityInvariant
=============================================================================
