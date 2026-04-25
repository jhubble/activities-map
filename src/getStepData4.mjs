import pkg from '@flow-js/garmin-connect';
import config from './config.mjs';
const { garmin_username, garmin_password } = config;

const { GarminConnect } = pkg;

async function getStepHistory() {
    // Adding a standard User-Agent can sometimes resolve 403s
    const GCClient = new GarminConnect({
        username: garmin_username,
        password: garmin_password,
    });

    try {
        console.log("--- Starting Debug Session ---");
        console.log(`Username loaded: ${garmin_username}`);

        // Attempt login
        await GCClient.login(); 
        console.log("Login successful.");

        const results = [];
        for (let i = 0; i < 3; i++) {
            const date = new Date();
            date.setDate(date.getDate() - i);
            const dateStr = date.toISOString().split('T')[0];
            
            console.log(`Fetching data for ${dateStr}...`);
            const stepData = await GCClient.getSteps(date);
            results.push({ date: dateStr, steps: stepData.totalSteps, goal: stepData.stepGoal });
        }

        console.table(results);

    } catch (error) {
        console.error("\n--- DEBUG ERROR REPORT ---");
        console.error(`Status Code: ${error.status || error.response?.status || 'N/A'}`);
        console.error(`Message: ${error.message}`);
        
        if (error.response) {
            // This pulls the actual body content from Garmin's rejection
            console.error("Response Data:", JSON.stringify(error.response.data, null, 2));
            console.error("Headers Sent:", JSON.stringify(error.config?.headers, null, 2));
        }
        
        if (error.message.includes("403")) {
            console.warn("\n[Possible Cause]: Garmin is blocking the request.");
            console.warn("1. Check if you have MFA (Multi-Factor Auth) enabled. Most JS libraries don't support it.");
            console.warn("2. Your IP might be temporarily flagged. Try using a VPN or waiting 15 minutes.");
        }
    }
}

getStepHistory();
