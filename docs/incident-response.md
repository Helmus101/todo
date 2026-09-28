# Incident Response Runbook

This document provides step-by-step procedures for handling common production incidents for Otto Lycée.

## Table of Contents

1. [Severity Levels](#severity-levels)
2. [Communication](#communication)
3. [Common Incidents](#common-incidents)
   - [AI Provider Outage](#ai-provider-outage)
   - [Composio Integration Failure](#composio-integration-failure)
   - [Supabase Database Issues](#supabase-database-issues)
   - [High Error Rates](#high-error-rates)
   - [Authentication Issues](#authentication-issues)
   - [Performance Degradation](#performance-degradation)
4. [Post-Incident Review](#post-incident-review)

## Severity Levels

| Severity | Description | Response Time | Example |
|----------|-------------|---------------|---------|
| **P0 - Critical** | Complete outage or data loss affecting all users | < 15 minutes | Database unavailable, app completely down |
| **P1 - Severe** | Major feature broken, significant user impact | < 1 hour | AI generation not working, login failing |
| **P2 - Moderate** | Partial degradation, some users affected | < 4 hours | Slow performance, specific integration failing |
| **P3 - Minor** | Low impact, non-critical issues | < 24 hours | UI glitches, minor feature bugs |

## Communication

### During Incident (P0/P1)

1. **Immediate**: Alert on-call engineer
2. **15 minutes**: Initial status update to stakeholders
3. **Every 30 minutes**: Status updates while incident is active
4. **Resolution**: Post-mortem summary within 24 hours

### Status Update Template

```
INCIDENT: [Brief description]
SEVERITY: [P0/P1/P2/P3]
STATUS: [Investigating/Identified/Monitoring/Resolved]
IMPACT: [Which users/features affected]
ETA: [Estimated resolution time, if known]
NEXT UPDATE: [Time of next status update]
```

## Common Incidents

### AI Provider Outage

**Symptoms:**
- Task generation returns errors
- Chat features fail
- AI-dependent features degraded

**Diagnosis:**
```bash
# Check health endpoint
curl https://your-domain.com/api/health/deep
# Look for ai check status
```

**Mitigation:**
1. Check DeepSeek/NVIDIA status page
2. Verify `DEEPSEEK_API_KEY` or `NVIDIA_API_KEY` is valid
3. Check circuit breaker state in `/api/status` response
4. If circuit breaker is OPEN, wait for recovery or manually reset after confirming service is back

**Recovery:**
1. Verify AI provider is operational
2. Check application logs for specific error messages
3. If API key was rotated, update environment variables
4. Restart the application if configuration changed
5. Monitor `/api/health/deep` until healthy

### Composio Integration Failure

**Symptoms:**
- Gmail/Calendar/Drive connections fail
- Integration flows error out
- Connected accounts show as disconnected

**Diagnosis:**
```bash
# Check health endpoint
curl https://your-domain.com/api/health/deep
# Look for composio check status
```

**Mitigation:**
1. Check Composio status page
2. Verify `COMPOSIO_API_KEY` is valid
3. Check Composio dashboard for API quota issues
4. Review circuit breaker state for Composio

**Recovery:**
1. Verify Composio service is operational
2. Check API key hasn't been revoked
3. If quota exceeded, upgrade plan or optimize usage
4. Restart application if configuration changed

### Supabase Database Issues

**Symptoms:**
- Login/signup fails
- Data not persisting
- Database errors in logs

**Diagnosis:**
```bash
# Check health endpoint
curl https://your-domain.com/api/health/deep
# Look for supabase check status
```

**Mitigation:**
1. Check Supabase status page
2. Verify database is accessible via Supabase dashboard
3. Check RLS policies haven't been modified
4. Verify connection string and credentials

**Recovery:**
1. If database is down, wait for Supabase recovery
2. If credentials were rotated, update environment variables
3. If RLS policies broke, restore from backup or fix policies
4. Run backup verification script: `node scripts/verify-backup.mjs`

**Backup Restoration:**
1. Identify the last known good backup
2. Use Supabase dashboard to restore point-in-time recovery
3. Verify data integrity after restoration
4. Monitor for any data inconsistencies

### High Error Rates

**Symptoms:**
- Increased 500 errors
- Sentry reporting spikes
- User complaints

**Diagnosis:**
```bash
# Check health endpoint
curl https://your-domain.com/api/health/shallow
# Check circuit breaker states
curl https://your-domain.com/api/status
# Look for circuitBreakers field
```

**Mitigation:**
1. Identify the source of errors from Sentry logs
2. Check if a specific endpoint is failing
3. Verify external dependencies are healthy
4. Check for recent deployments

**Recovery:**
1. If recent deployment caused issues, roll back
2. If circuit breaker is OPEN, address the failing service
3. Restart application if in error state
4. Monitor error rates until normal

### Authentication Issues

**Symptoms:**
- Users cannot log in
- Signup fails
- Session errors

**Diagnosis:**
```bash
# Check auth endpoints
curl -X POST https://your-domain.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"test"}'
```

**Mitigation:**
1. Verify `SESSION_SECRET` is set and unchanged
2. Check Supabase auth configuration
3. Verify session store is working
4. Check rate limiting isn't blocking legitimate users

**Recovery:**
1. If `SESSION_SECRET` was rotated, restart application
2. If Supabase auth is down, wait for recovery
3. If rate limiting is too aggressive, adjust limits
4. Clear any stuck sessions if needed

### Performance Degradation

**Symptoms:**
- Slow page loads
- Timeouts
- High CPU/memory usage

**Diagnosis:**
```bash
# Check response times
curl -w "@curl-format.txt" -o /dev/null -s https://your-domain.com/api/status
```

**Mitigation:**
1. Check Vercel analytics for response time trends
2. Review database query performance
3. Check for memory leaks in background jobs
4. Verify external service latency

**Recovery:**
1. If database queries are slow, add indexes or optimize queries
2. If memory usage is high, restart application
3. If external services are slow, increase timeouts
4. Scale up resources if needed

## Post-Incident Review

After resolving any P0 or P1 incident, conduct a post-incident review within 24 hours.

### Review Template

**Incident Summary:**
- Date and time of incident
- Duration of incident
- Severity level
- Number of users affected

**Timeline:**
- When was the incident detected?
- When was it acknowledged?
- When was it resolved?
- Key events during the incident

**Root Cause:**
- What caused the incident?
- Was there a single point of failure?
- Were there any contributing factors?

**Resolution:**
- What steps were taken to resolve?
- Was a rollback required?
- What worked well in the response?

**Prevention:**
- What can be done to prevent recurrence?
- Are there monitoring gaps to address?
- Are there code/process improvements needed?

**Action Items:**
- [ ] Specific improvement 1
- [ ] Specific improvement 2
- [ ] Update documentation if needed

## Monitoring and Alerts

Ensure the following monitoring is in place:

1. **Health Checks**: Monitor `/api/health/shallow` and `/api/health/deep`
2. **Error Rates**: Alert on 5xx error rate > 5%
3. **Response Time**: Alert on p95 latency > 2s
4. **Circuit Breakers**: Alert when any circuit breaker opens
5. **Database Connectivity**: Alert on Supabase connection failures
6. **AI Provider**: Alert on AI service failures

## Contact Information

- **On-Call Engineer**: [Contact]
- **Engineering Lead**: [Contact]
- **Product Owner**: [Contact]
- **Supabase Support**: https://supabase.com/support
- **DeepSeek Support**: [Contact]
- **Composio Support**: https://composio.dev/support
