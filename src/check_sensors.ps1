# Quick sensor check script
Write-Host "Checking MMS API..." -ForegroundColor Cyan

try {
    $response = Invoke-RestMethod -Uri "http://localhost:8000/factories/F1/sensors" -Method Get
    
    Write-Host "`nFactory F1 Sensor Status:" -ForegroundColor Green
    Write-Host "  Total Sensors: $($response.data.total_sensors)"
    Write-Host "  Healthy: $($response.data.healthy_count)"
    Write-Host "  Failed: $($response.data.failed_count)"
    Write-Host "  At Risk: $($response.data.at_risk_count)"
    
    if ($response.data.healthy_sensors.Count -gt 0) {
        Write-Host "`nHealthy Sensors:" -ForegroundColor Green
        foreach ($sensor in $response.data.healthy_sensors) {
            Write-Host "  - $($sensor.sensor_id) (Tier: $($sensor.tier))"
        }
    }
    
    Write-Host "`n✓ API is working!" -ForegroundColor Green
    
} catch {
    Write-Host "`n✗ API Error: $_" -ForegroundColor Red
}

Write-Host "`nDashboard URL: http://localhost:3000" -ForegroundColor Cyan
