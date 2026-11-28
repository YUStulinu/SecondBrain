# Postmortem: checkout outage of 14 October

(A fictional incident, written as sample material for the Second Brain demo.)

## Summary

On 14 October, from 09:12 to 10:05 UTC, customers could not complete a purchase: 38% of checkout
requests failed with HTTP 503. About 4,200 orders were lost or delayed.

## Timeline

- 09:00: version 4.18 of the payments service is deployed.
- 09:12: error rate on checkout rises above 30%; the on-call engineer is paged.
- 09:31: the team links the errors to the new database connection pool.
- 09:48: version 4.18 is rolled back to 4.17.
- 10:05: error rate is back below 0.1%.

## Root cause

Version 4.18 lowered the database connection pool from 50 to 10 connections per instance, a value
copied by mistake from a test configuration. Under morning traffic, requests waited for a
connection longer than the 5-second timeout and failed.

## What went well

The alert fired within two minutes of the first errors, and the rollback took 17 minutes.

## What we will change

1. Configuration values for production are checked against a schema before a deploy.
2. Canary deploys: a new version takes 5% of traffic for 30 minutes before the rest.
3. The connection pool size is added to the payments dashboard.

Owner of the follow-ups: Priya Raman, due 15 November.
