package com.saiexpress.payparking;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(PlateReaderPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
