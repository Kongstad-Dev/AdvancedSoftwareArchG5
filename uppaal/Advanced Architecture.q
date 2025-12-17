//This file was generated from (Academic) UPPAAL 5.0.0 (rev. 714BA9DB36F49691), 2023-06-21

/*
Checks if the system can always proceed from its current state. A deadlock means the model is stuck.
*/
A[] not deadlock

/*
Checks if the state in the model (Sensor0.Failed) always matches the global shared array (sensorState[0]).
*/
A[] (Sensor0.Failed imply sensorState[0] == FAILED)

/*
Checks if it is possible for the PMS to enter the state where it updates the primary sensor ID.
*/
E<> PMS0.UpdatePrimary

/*
Checks if Sensor 0 is only OCCUPIED when it is the primary.
*/
A[] (sensorState[0] == OCCUPIED imply 0 == primarySensorID)

/*
Checks if Sensor 1 is only OCCUPIED when it is the primary.
*/
A[] (sensorState[1] == OCCUPIED imply 1 == primarySensorID)

/*
Checks if the system always avoids a state where the Queue is in a hypothetical SendingRequest location AND the primary sensor is busy (OCCUPIED, ATRISK, or FAILED).
*/
A[] not (Queue0.Sending and sensorState[primarySensorID] != FREE)

/*
This query checks that if Sensor0 fails, the system can eventually move Sensor1 into the OCCUPIED state by setting it as the new primary sensor.
*/
E<> (primarySensorID == 1 && Sensor1.Occupied)

/*

*/
Pr[time <= 1000] (<> Sensor0.Free)
